// Master limiter — a lookahead, stereo-linked peak limiter, the last stage
// before the destination and the recorder (specs/features/master-limiter.md).
//
// The gain computer, per sample:
//
//   x      = in · drive                     (a non-finite sample is read as 0)
//   p      = max(|xL|, |xR|)                 stereo-linked detector
//   target = p > ceil ? ceil / p : 1         the gain this sample needs
//   hold   = min(target) over L+1 samples    sliding-window minimum (monotonic deque)
//   slow   = one-pole toward hold            300 ms down / 600 ms up
//   fast   = min(hold, fast + (slow − fast)·kFast)   instant down, ~50 ms back up to slow
//   g      = mean(fast) over L+1 samples     the attack: a ramp across the lookahead
//   y      = delay_L(x) · g, clamped to ±ceil (a backstop that never engages)
//
// Why |y| ≤ ceil (REQ-the-output-never-exceeds-the-ceiling): the sample that
// entered at t0 leaves at t0+L, times the mean of fast[t0 … t0+L]. Each of those
// is ≤ the hold at its own time k, and every hold window [k−L, k] contains t0, so
// g ≤ target[t0]. At rest every term is exactly 1 and g is set to exactly 1, so
// in-range audio comes out bit-exact, L samples late (REQ-in-range-audio-passes-unchanged).
//
// The release is the program-dependent part (REQ-release-follows-the-program):
// a lone transient barely moves `slow`, so `fast` recovers to ~1 in ~50 ms; a
// sustained overload drags `slow` down, and `fast` can then only come back as
// quickly as `slow` releases. Constants tuned by ear (ADR-010).
//
// Gain reduction (dB, deepest in the window) is posted on the port every 12
// blocks (~31 Hz), and nothing is posted while idle — the compressor's contract.

const LOOKAHEAD_S = 0.0015;
const FAST_RELEASE_S = 0.05;
const SLOW_ATTACK_S = 0.3;
const SLOW_RELEASE_S = 0.6;
const METER_INTERVAL_BLOCKS = 12;
const REST_EPS = 1e-7; // an envelope this close to 1 at block end snaps to exactly 1
// The target sits this far under the exact ceiling, so the rounding of the
// running mean (~1e-14 relative) can never carry a peak over it and the
// backstop clamp truly never engages. Far below audibility (-9e-12 dB).
const TARGET_MARGIN = 1 - 1e-12;
const LN10_20 = Math.LN10 / 20; // dB → linear as exp(dB · LN10_20)
const DB_PER_LN = 20 / Math.LN10; // linear → dB as ln(g) · DB_PER_LN

let SILENCE = new Float32Array(128);

class MasterLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 0, minValue: 0, maxValue: 12, automationRate: 'k-rate' },
      { name: 'ceiling', defaultValue: 0, minValue: -6, maxValue: 0, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    const L = Math.max(1, Math.round(LOOKAHEAD_S * sr));
    const len = L + 1;
    this.L = L;
    this.len = len;
    this.invLen = 1 / len;

    // The audio delay line: L samples per channel, written then read in turn.
    this.dL = new Float64Array(L);
    this.dR = new Float64Array(L);
    this.dPos = 0;

    // Sliding-window minimum of `target`: a deque of (time, value) in two
    // rings. It never holds more than `len` entries, since each is evicted
    // once it is older than the window.
    this.qT = new Float64Array(len);
    this.qV = new Float64Array(len);
    this.qHead = 0;
    this.qSize = 0;
    this.t = 0;

    // The box filter: the last `len` values of `fast`, and their running sum.
    this.box = new Float64Array(len).fill(1);
    this.boxPos = 0;
    this.boxSum = len;

    this.fast = 1;
    this.slow = 1;
    this.kFast = 1 - Math.exp(-1 / (FAST_RELEASE_S * sr));
    this.kSlowA = 1 - Math.exp(-1 / (SLOW_ATTACK_S * sr));
    this.kSlowR = 1 - Math.exp(-1 / (SLOW_RELEASE_S * sr));

    this.driveDb = 0;
    this.driveLin = 1;
    this.ceilDb = 0;
    this.ceilLin = 1;

    this.blockCount = 0;
    this.minG = 1;
    this.lastPosted = 0;
    this.backstopHits = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    // k-rate params → linear, only when they move. 0 dB is exactly 1.
    const driveDb = params.drive[0];
    const drive0 = this.driveLin;
    if (driveDb !== this.driveDb) {
      this.driveDb = driveDb;
      this.driveLin = driveDb === 0 ? 1 : Math.exp(driveDb * LN10_20);
    }
    const drive1 = this.driveLin;
    const ceilDb = params.ceiling[0];
    if (ceilDb !== this.ceilDb) {
      this.ceilDb = ceilDb;
      this.ceilLin = ceilDb === 0 ? 1 : Math.exp(ceilDb * LN10_20);
    }
    const ceil = this.ceilLin;

    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const n = outL.length;
    if (SILENCE.length < n) SILENCE = new Float32Array(n);
    const srcL = inL || SILENCE;
    const srcR = inR || SILENCE;

    // Drive is interpolated across a block in which it moved (REQ-drive-and-ceiling-are-continuous).
    const ramp = drive0 !== drive1;
    const dStep = ramp ? (drive1 - drive0) / n : 0;

    const L = this.L;
    const len = this.len;
    const invLen = this.invLen;
    const dL = this.dL;
    const dR = this.dR;
    const qT = this.qT;
    const qV = this.qV;
    const box = this.box;
    const kFast = this.kFast;
    const kSlowA = this.kSlowA;
    const kSlowR = this.kSlowR;
    let dPos = this.dPos;
    let qHead = this.qHead;
    let qSize = this.qSize;
    let t = this.t;
    let boxPos = this.boxPos;
    let boxSum = this.boxSum;
    let fast = this.fast;
    let slow = this.slow;
    let minG = this.minG;

    for (let i = 0; i < n; i++) {
      const drive = ramp ? drive0 + dStep * (i + 1) : drive1;
      let xl = srcL[i] * drive;
      let xr = srcR[i] * drive;
      // REQ-non-finite-input-never-reaches-state: x − x is NaN for NaN and ±Inf.
      if (xl - xl !== 0) xl = 0;
      if (xr - xr !== 0) xr = 0;

      const al = xl < 0 ? -xl : xl;
      const ar = xr < 0 ? -xr : xr;
      const p = al > ar ? al : ar;
      const target = p > ceil ? (ceil / p) * TARGET_MARGIN : 1;

      // Sliding-window minimum over [t − L, t]. Evict the expired front first,
      // so the deque holds at most L entries before the push and `len` after.
      while (qSize > 0 && qT[qHead] < t - L) {
        qHead = qHead + 1 === len ? 0 : qHead + 1;
        qSize--;
      }
      while (qSize > 0) {
        const back = (qHead + qSize - 1) % len;
        if (qV[back] >= target) qSize--;
        else break;
      }
      const slot = (qHead + qSize) % len;
      qT[slot] = t;
      qV[slot] = target;
      qSize++;
      const hold = qV[qHead];

      // Program-dependent release.
      slow += (hold - slow) * (hold < slow ? kSlowA : kSlowR);
      const rel = fast + (slow - fast) * kFast;
      fast = hold < rel ? hold : rel;

      // Attack: the mean of `fast` across the lookahead.
      boxSum += fast - box[boxPos];
      box[boxPos] = fast;
      boxPos = boxPos + 1 === len ? 0 : boxPos + 1;
      const g = boxSum >= len ? 1 : boxSum * invLen;
      if (g < minG) minG = g;

      // Delay line: read the sample from L ago, write this one in its place.
      const yl = dL[dPos] * g;
      const yr = dR[dPos] * g;
      dL[dPos] = xl;
      dR[dPos] = xr;
      dPos = dPos + 1 === L ? 0 : dPos + 1;

      // Backstop (REQ-the-output-never-exceeds-the-ceiling): the gain computer
      // already keeps |y| ≤ ceil; this catches a rounding hair and counts it,
      // so a test can pin that it never engages. The count is off the hot path.
      const ml = yl < 0 ? -yl : yl;
      const mr = yr < 0 ? -yr : yr;
      if (ml > ceil || mr > ceil) {
        this.backstopHits++;
        outL[i] = ml > ceil ? (yl < 0 ? -ceil : ceil) : yl;
        if (outR) outR[i] = mr > ceil ? (yr < 0 ? -ceil : ceil) : yr;
      } else {
        outL[i] = yl;
        if (outR) outR[i] = yr;
      }
      t++;
    }

    // Settle the envelopes to exactly 1 once nothing in the window needs a
    // reduction (REQ-silence-in-is-silence-out) — only then, so a snap can
    // never lift the gain above what a held peak needs. Within one window the
    // box holds nothing but those exact 1s and the sum is exactly `len`.
    // Resyncing the running sum here also keeps it from drifting.
    if (qSize > 0 && qV[qHead] === 1) {
      if (1 - fast < REST_EPS) fast = 1;
      if (1 - slow < REST_EPS) slow = 1;
    }
    let sum = 0;
    for (let j = 0; j < len; j++) sum += box[j];
    boxSum = sum;

    this.dPos = dPos;
    this.qHead = qHead;
    this.qSize = qSize;
    this.t = t;
    this.boxPos = boxPos;
    this.boxSum = boxSum;
    this.fast = fast;
    this.slow = slow;

    if (++this.blockCount >= METER_INTERVAL_BLOCKS) {
      const gr = minG < 1 ? -Math.log(minG) * DB_PER_LN : 0;
      if (gr > 0.01 || this.lastPosted > 0.01) {
        this.port.postMessage(gr);
        this.lastPosted = gr;
      }
      minG = 1;
      this.blockCount = 0;
    }
    this.minG = minG;

    return true;
  }
}

registerProcessor('master-limiter', MasterLimiterProcessor);
