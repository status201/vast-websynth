/**
 * Oscillator-sync pair — oscillator-sync.md.
 *
 * Renders osc1 (the master, output 0) and osc2 (the slave, output 1) together, so
 * the phase relation between them is structural rather than two clocks that could
 * drift apart (REQ-the-pair-owns-both-phases). Runs only while sync is engaged;
 * the native oscillators carry the sound otherwise.
 *
 * Every discontinuity — a waveform's own edge, a hard-sync reset, a reversal, a
 * wave or width change — is corrected with a band-limited residual: a step
 * (BLEP) scaled by the value jump, a ramp (BLAMP) scaled by the slope jump and,
 * for a sine reset, a third-order term scaled by the curvature jump — each placed
 * at the event's sub-sample time (REQ-every-discontinuity-is-band-limited).
 * The residuals come from a windowed-sinc kernel integrated once and shared by
 * every instance. A linear-phase kernel needs lookahead, so both outputs are
 * delayed by its half-length — the same delay on both, so the pair stays aligned.
 *
 * Musical, stable, cheap (ADR-010): cost follows events per second, not the
 * sample rate; every increment is clamped below Nyquist and every param is
 * guarded against NaN, so the output is bounded for any input.
 */

const TAU = 2 * Math.PI;

const SINE = 0;
const TRI = 1;
const SAW = 2;
const SQUARE = 3;

/** `mode`: 0 = free-running (no sync), 1 = hard, 2 = reversing. */
const MODE_HARD = 1;
const MODE_REVERSE = 2;

/** No oscillator may step more than this much phase per sample: one event per
 *  breakpoint per sample at most, and nothing at or past Nyquist. */
const MAX_INC = 0.45;
/** Bounds on the slave's sync offset in semitones, before the increment clamp. */
const SYNC_MIN = -24;
const SYNC_MAX = 72;
/** Bound on the linear FM index, however many matrix routes sum into it
 *  (cross-modulation.md REQ-cross-mod-is-bounded). */
const FM_MAX = 16;
/** The slave's DC blocker corner. A synced wave's mean moves with the ratio, and
 *  a sweep would push that sub-audio wobble into the filter (REQ-the-slave-is-dc-free). */
const DC_HZ = 5;

/** Correction ring: must exceed twice the longest kernel half-length. */
const RING = 64;
const RING_MASK = RING - 1;

/** Oversampling of the residual tables. */
const TABLE_OS = 64;

/** Kernel cutoff as a fraction of the sample rate. With the 4-term Blackman-Harris
 *  window the transition band is ~8/(2·half) wide, so the stop band starts near
 *  Nyquist rather than straddling it. */
const SINC_FC = 0.42;
/** The shipped half-length: 16 taps each side, 16 samples of shared latency. The
 *  alias test measured 8 the same below 10 kHz but 15-25 dB worse above it. */
const DEFAULT_HALF = 16;

const kernels = new Map();

/**
 * The integrated kernel B(x) (a band-limited step, 0 → 1) and its integral A(x)
 * (a band-limited ramp), on x ∈ [-half, half] at `TABLE_OS` points per sample.
 * The residuals are B - H(x) and A - max(0, x), with the ideal step and ramp
 * subtracted analytically at lookup time: subtracting them into the table would
 * put a jump at x = 0 that linear interpolation then smears.
 */
function buildKernel(kind, half) {
  const key = kind + ':' + half;
  const hit = kernels.get(key);
  if (hit) return hit;
  const n = 2 * half * TABLE_OS + 1;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = -half + i / TABLE_OS;
    if (kind === 'poly') {
      // Linear-interpolation (triangle) kernel: integrating it gives the
      // classic 2-point polyBLEP. Kept so the alias test can rank against it.
      h[i] = Math.max(0, 1 - Math.abs(x));
    } else {
      const y = 2 * SINC_FC * x;
      const sinc = y === 0 ? 1 : Math.sin(Math.PI * y) / (Math.PI * y);
      const w = (x + half) / (2 * half);
      const win = 0.35875 - 0.48829 * Math.cos(TAU * w) + 0.14128 * Math.cos(2 * TAU * w)
        - 0.01168 * Math.cos(3 * TAU * w);
      h[i] = sinc * win;
    }
  }
  const B = new Float64Array(n);
  for (let i = 1; i < n; i++) B[i] = B[i - 1] + (h[i - 1] + h[i]) / (2 * TABLE_OS);
  const total = B[n - 1];
  for (let i = 0; i < n; i++) B[i] /= total;
  const A = new Float64Array(n);
  for (let i = 1; i < n; i++) A[i] = A[i - 1] + (B[i - 1] + B[i]) / (2 * TABLE_OS);
  // Third order: the band-limited onset of a curvature jump. Its ideal tail
  // settles to x²/2 plus a constant `c` (the kernel's second moment), so `c·B` is
  // subtracted to end the residual at zero — that leaves the correction a
  // band-limited step of -c·dc, a DC nudge the slave's blocker removes.
  const C = new Float64Array(n);
  for (let i = 1; i < n; i++) C[i] = C[i - 1] + (A[i - 1] + A[i]) / (2 * TABLE_OS);
  const c = C[n - 1] - (half * half) / 2;
  const k = { half, B, A, C, c };
  kernels.set(key, k);
  return k;
}

function value(wave, p, width) {
  switch (wave) {
    case SINE: return Math.sin(TAU * p);
    case TRI: return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case SAW: return 2 * p - 1;
    default: return (p < width ? 1 : -1) - (2 * width - 1);
  }
}

/** d value / d phase. */
function slope(wave, p) {
  switch (wave) {
    case SINE: return TAU * Math.cos(TAU * p);
    case TRI: return p < 0.5 ? 4 : -4;
    case SAW: return 2;
    default: return 0;
  }
}

/** d² value / d phase² — only the sine curves; the others are piecewise linear. */
function curve(wave, p) {
  return wave === SINE ? -TAU * TAU * Math.sin(TAU * p) : 0;
}

/** The one interior breakpoint of a wave (its wrap at 0/1 is handled apart), or -1. */
function innerBreak(wave, width) {
  if (wave === TRI) return 0.5;
  if (wave === SQUARE) return width;
  return -1;
}

const EPS = 1e-9;

function makeOsc() {
  return { p: 0, dir: 1, wave: SAW, width: 0.5 };
}

class SyncOscProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 440, minValue: 0, maxValue: 24000, automationRate: 'a-rate' },
      // The voice's shared pitch modulation (bend, LFO, drift, matrix), cents.
      { name: 'detune', defaultValue: 0, minValue: -9600, maxValue: 9600, automationRate: 'a-rate' },
      // Each oscillator's own octave + fine tune, cents.
      { name: 'masterCents', defaultValue: 0, minValue: -4800, maxValue: 4800, automationRate: 'k-rate' },
      { name: 'slaveCents', defaultValue: 0, minValue: -4800, maxValue: 4800, automationRate: 'k-rate' },
      // The sync sweep, semitones above the slave's own pitch.
      { name: 'syncPitch', defaultValue: 0, minValue: -48, maxValue: 96, automationRate: 'a-rate' },
      // Linear FM of the slave by the master, as an index relative to the master's
      // frequency — the same β the native path uses (cross-modulation.md REQ-fm-reaches-the-sync-pair).
      { name: 'fm', defaultValue: 0, minValue: -FM_MAX, maxValue: FM_MAX, automationRate: 'a-rate' },
      { name: 'wave1', defaultValue: SAW, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'wave2', defaultValue: SAW, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'width1', defaultValue: 0.5, minValue: 0.5, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'width2', defaultValue: 0.5, minValue: 0.5, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'mode', defaultValue: MODE_HARD, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    // `kernel` / `half` exist so the alias test can rank the shipped kernel
    // against polyBLEP and a naive reset; the node never passes them.
    const kind = o.kernel === 'poly' || o.kernel === 'naive' ? o.kernel : 'sinc';
    const half = kind === 'poly' ? 1 : kind === 'naive' ? 0
      : Math.max(1, Math.min(RING / 2 - 1, Math.round(o.half || DEFAULT_HALF)));
    this.half = half;
    this.kernel = half > 0 ? buildKernel(kind, half) : null;
    this.m = makeOsc();
    this.s = makeOsc();
    this.acc0 = new Float64Array(RING);
    this.acc1 = new Float64Array(RING);
    this.n = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.dcR = 1 - (TAU * DC_HZ) / sampleRate;
    // The master's naive value at the previous sample: FM's modulator, one sample
    // late, which no ear resolves and which costs nothing to keep.
    this.mPrev = 0;
    // Per-sample exp2 is the hot spot under vibrato, so each a-rate factor is
    // recomputed only when its input actually moved.
    this.lastD = NaN; this.lastDE = 1;
    this.lastSp = NaN; this.lastSpE = 1;
    // Same idle gate as the ladder filter (ladder-filter.md REQ-the-filter-idles-when-gated):
    // defaults on, so a lost message can only cost CPU, never a note.
    this.active = true;
    this.port.onmessage = (e) => {
      const on = e.data === true;
      if (on && !this.active) this.reset();
      this.active = on;
    };
  }

  reset() {
    this.acc0.fill(0);
    this.acc1.fill(0);
    this.dcX = 0;
    this.dcY = 0;
    this.mPrev = 0;
  }

  /**
   * Add the band-limited residuals of a value jump `dv`, a slope jump `ds` (per
   * sample) and a curvature jump `dc` (per sample²) at time `u` ∈ [0,1] of
   * sample n's interval. A zero term costs nothing.
   */
  emit(acc, u, dv, ds, dc = 0) {
    const k = this.kernel;
    if (!k) return;
    const half = k.half;
    // x_j = (j - half) + (1 - u): one fractional offset for every tap.
    let pos = (1 - u) * TABLE_OS;
    let base = pos | 0;
    let f = pos - base;
    if (base >= TABLE_OS) { base = TABLE_OS - 1; f = 1; }
    const start = this.n - half;
    const B = k.B, A = k.A, C = k.C, cc = k.c;
    for (let j = 0; j < 2 * half; j++) {
      const i = j * TABLE_OS + base;
      const x = j - half + 1 - u;
      let r = 0;
      if (dv !== 0) {
        const b = B[i] + (B[i + 1] - B[i]) * f;
        r += dv * (b - (x >= 0 ? 1 : 0));
      }
      if (ds !== 0) {
        const a = A[i] + (A[i + 1] - A[i]) * f;
        r += ds * (a - (x > 0 ? x : 0));
      }
      if (dc !== 0) {
        const cv = C[i] + (C[i + 1] - C[i]) * f;
        const b = B[i] + (B[i + 1] - B[i]) * f;
        r += dc * (cv - (x > 0 ? 0.5 * x * x : 0) - cc * b);
      }
      acc[(start + j) & RING_MASK] += r;
    }
  }

  /**
   * Move `o` through the time span [u0, u1) of the current sample at `inc` phase
   * per sample, emitting each breakpoint it crosses. Returns the time of a wrap
   * past 1 (the master's reset instant), or -1.
   */
  advance(o, acc, u0, u1, inc) {
    // Fast path — no breakpoint inside this span, which is nearly every sample:
    // one multiply and two compares, no division.
    const step = inc * (u1 - u0);
    const ib = innerBreak(o.wave, o.width);
    if (o.dir > 0) {
      const next = ib > o.p ? ib : 1;
      const q = o.p + step;
      if (q < next) { o.p = q; return -1; }
    } else {
      const next = ib >= 0 && ib < o.p ? ib : 0;
      const q = o.p - step;
      if (q > next) { o.p = q; return -1; }
    }
    let wrapAt = -1;
    let t = u0;
    let guard = 4;
    while (t < u1 && guard-- > 0) {
      let dist; let bp;
      if (o.dir > 0) {
        if (ib > o.p) { dist = ib - o.p; bp = ib; } else { dist = 1 - o.p; bp = 1; }
      } else {
        if (o.p === 0) o.p = 1;
        if (ib >= 0 && ib < o.p) { dist = o.p - ib; bp = ib; } else { dist = o.p; bp = 0; }
      }
      const tHit = inc > 0 ? t + dist / inc : Infinity;
      // Strict: a breakpoint landing exactly on the span's end is still crossed
      // here. Treating it as "next span" let the phase normalise past 1 below with
      // no event at all — a master wrap that never reset the slave, on any period
      // that is a whole number of samples.
      if (tHit > u1) {
        o.p += o.dir * inc * (u1 - t);
        break;
      }
      // Crossing. Wrap breakpoints sit at both 0 and 1.
      const wrap = bp === 0 || bp === 1;
      const lo = wrap ? 1 - EPS : bp - EPS;
      const hi = wrap ? EPS : bp + EPS;
      const before = o.dir > 0 ? lo : hi;
      const after = o.dir > 0 ? hi : lo;
      const dv = value(o.wave, after, o.width) - value(o.wave, before, o.width);
      const ds = (slope(o.wave, after) - slope(o.wave, before)) * o.dir * inc;
      // A sine's wrap is smooth: nothing to correct, so skip the taps.
      if (dv > 1e-7 || dv < -1e-7 || ds > 1e-9 || ds < -1e-9) this.emit(acc, tHit, dv, ds);
      if (wrap) {
        o.p = o.dir > 0 ? 0 : 1;
        if (o.dir > 0) wrapAt = tHit;
      } else {
        o.p = bp;
      }
      t = tHit;
      // Step off the breakpoint so the next search starts beyond it.
      if (!wrap) o.p += o.dir * 1e-12;
    }
    if (o.p >= 1) o.p -= 1;
    if (o.p < 0) o.p += 1;
    return wrapAt;
  }

  /**
   * A wave or width change between blocks is a jump at the current phase like any
   * other. Only the value is corrected — the slope change of a wave switch is a
   * one-off, far smaller than the step itself.
   */
  retarget(o, acc, wave, width) {
    if (wave === o.wave && width === o.width) return;
    const dv = value(wave, o.p, width) - value(o.wave, o.p, o.width);
    o.wave = wave;
    o.width = width;
    // Just before this block's first sample, so that sample carries the new shape.
    if (dv !== 0) this.emit(acc, 1 - 1e-9, dv, 0);
  }

  /**
   * The sync event itself, at time `u` in the current sample. Hard: the slave
   * jumps to the start of its cycle, so its value, slope and (for a sine)
   * curvature all jump. Reversing: it turns round in place, so only the slope
   * flips. `advance` resumes from the new phase over the rest of the sample,
   * which is what keeps the master's overshoot (REQ-the-reset-keeps-the-overshoot).
   */
  syncSlave(mode, u, inc) {
    const s = this.s;
    if (mode === MODE_HARD) {
      const dv = value(s.wave, EPS, s.width) - value(s.wave, s.p, s.width);
      const ds = (slope(s.wave, EPS) - slope(s.wave, s.p) * s.dir) * inc;
      const dc = (curve(s.wave, EPS) - curve(s.wave, s.p)) * inc * inc;
      this.emit(this.acc1, u, dv, ds, dc);
      s.p = 0;
      s.dir = 1;
    } else {
      this.emit(this.acc1, u, 0, -2 * slope(s.wave, s.p) * s.dir * inc);
      s.dir = -s.dir;
    }
  }

  process(_inputs, outputs, params) {
    const out0 = outputs[0] && outputs[0][0];
    const out1 = outputs[1] && outputs[1][0];
    if (!out0 || !out1) return true;
    const len = out0.length;
    if (!this.active) {
      out0.fill(0);
      out1.fill(0);
      return true;
    }

    const freq = params.frequency;
    const det = params.detune;
    const sync = params.syncPitch;
    const fm = params.fm;
    const mCents = finiteOr(params.masterCents[0], 0);
    const sCents = finiteOr(params.slaveCents[0], 0);
    const mode = Math.round(finiteOr(params.mode[0], MODE_HARD));
    const w1 = waveIndex(params.wave1[0]);
    const w2 = waveIndex(params.wave2[0]);
    const pw1 = widthOf(params.width1[0]);
    const pw2 = widthOf(params.width2[0]);
    const half = this.half;

    this.retarget(this.m, this.acc0, w1, pw1);
    this.retarget(this.s, this.acc1, w2, pw2);
    if (mode !== MODE_REVERSE) this.s.dir = 1;

    // The two per-block pitch constants; the a-rate parts are folded in per sample.
    const mK = exp2(mCents / 1200) / sampleRate;
    const sK = exp2(sCents / 1200) / sampleRate;
    const fFull = freq.length > 1, dFull = det.length > 1, spFull = sync.length > 1;
    const fmFull = fm !== undefined && fm.length > 1;
    const fm0 = fm !== undefined ? fm[0] : 0;
    const maxInc = MAX_INC;

    for (let i = 0; i < len; i++) {
      // NaN-safe by construction: every comparison below maps NaN to the safe
      // branch, so no per-sample isFinite is needed (the block-end guard backs it up).
      const f = fFull ? freq[i] : freq[0];
      const d = dFull ? det[i] : det[0];
      let sp = spFull ? sync[i] : sync[0];
      sp = sp > SYNC_MIN ? (sp < SYNC_MAX ? sp : SYNC_MAX) : SYNC_MIN;

      if (d !== this.lastD) { this.lastD = d; this.lastDE = exp2(d / 1200); }
      if (sp !== this.lastSp) { this.lastSp = sp; this.lastSpE = exp2(sp / 12); }
      const base = f * this.lastDE;
      let mInc = base * mK;
      let sInc = base * this.lastSpE * sK;
      // Linear FM: the slave's frequency moves by β master-frequencies per unit of
      // master signal. Not through-zero — the clamp below stops it at 0 Hz. NaN
      // fails both comparisons and lands on 0, so a bad β is simply no FM.
      let b = fmFull ? fm[i] : fm0;
      b = b > -FM_MAX ? (b < FM_MAX ? b : FM_MAX) : (b <= -FM_MAX ? -FM_MAX : 0);
      if (b !== 0) sInc += b * mInc * this.mPrev;
      mInc = mInc > 0 ? (mInc < maxInc ? mInc : maxInc) : 0;
      sInc = sInc > 0 ? (sInc < maxInc ? sInc : maxInc) : 0;

      const reset = this.advance(this.m, this.acc0, 0, 1, mInc);
      if (reset >= 0 && (mode === MODE_HARD || mode === MODE_REVERSE)) {
        // The slave runs up to the master's wrap, is synced there, then runs on.
        this.advance(this.s, this.acc1, 0, reset, sInc);
        this.syncSlave(mode, reset, sInc);
        this.advance(this.s, this.acc1, reset, 1, sInc);
      } else {
        this.advance(this.s, this.acc1, 0, 1, sInc);
      }

      const slot = this.n & RING_MASK;
      const mv = value(this.m.wave, this.m.p, this.m.width);
      this.mPrev = mv;
      this.acc0[slot] += mv;
      this.acc1[slot] += value(this.s.wave, this.s.p, this.s.width);
      const outSlot = (this.n - half) & RING_MASK;
      const y0 = this.acc0[outSlot];
      const x1 = this.acc1[outSlot];
      this.acc0[outSlot] = 0;
      this.acc1[outSlot] = 0;
      const y1 = x1 - this.dcX + this.dcR * this.dcY;
      this.dcX = x1;
      this.dcY = y1;
      out0[i] = y0;
      out1[i] = y1;
      this.n++;
    }

    // Stable (ADR-010): anything non-finite that slipped through resets the pair
    // rather than latching NaN into the filter downstream.
    if (!Number.isFinite(out0[len - 1]) || !Number.isFinite(out1[len - 1])) {
      this.reset();
      this.m = makeOsc();
      this.s = makeOsc();
      out0.fill(0);
      out1.fill(0);
    }
    return true;
  }
}

/** 2^n for `exp2`'s rounded integer part, n ∈ [-64, 64]. */
const POW2 = new Float64Array(129);
for (let i = 0; i < 129; i++) POW2[i] = Math.pow(2, i - 64);

/**
 * 2^x by a degree-6 Taylor polynomial on the rounded fraction, |f| <= 0.5:
 * relative error ~1e-7, i.e. under 0.0002 cents — far cheaper than Math.pow,
 * which dominated the loop under vibrato. Out-of-table exponents clamp.
 */
function exp2(x) {
  let n = Math.round(x);
  const f = x - n;
  n = n < -64 ? -64 : n > 64 ? 64 : n;
  const p = 1 + f * (0.6931471805599453 + f * (0.2402265069591007 + f * (0.05550410866482158
    + f * (0.009618129107628477 + f * (0.0013333558146428443 + f * 0.00015403530393381606)))));
  return p * POW2[n + 64];
}

function finiteOr(v, d) {
  return Number.isFinite(v) ? v : d;
}

function waveIndex(v) {
  const i = Math.round(finiteOr(v, SAW));
  return i < 0 ? 0 : i > 3 ? 3 : i;
}

function widthOf(v) {
  const w = finiteOr(v, 0.5);
  return w < 0.5 ? 0.5 : w > 0.95 ? 0.95 : w;
}

registerProcessor('sync-osc', SyncOscProcessor);
