// Hardware-modelled bus compressor. One processor, two character modes,
// fixed per instance via processorOptions.mode:
//
//  'fet' — UREI 1176 style. Feedback detector (the sidechain taps the
//          already-gain-reduced signal), hard knee, microsecond attacks,
//          dual-time-constant program-dependent release, FET-ish asymmetric
//          tanh saturation whose drive scales with gain reduction. Because
//          the loop sees reduced signal, a nominal 4:1 behaves nearer 3:1
//          with a naturally rounded knee — that is the authentic behaviour.
//          ratio >= 100 engages "all buttons in": near-limiting slope plus a
//          quadratic overshoot so the curve sits down hard on peaks.
//
//  'vca' — SSL G-Series bus style. Feed-forward detector, 6 dB soft knee
//          (the "glue"), clean VCA gain (no saturation), and an auto-release
//          (autoRelease >= 0.5) modelling the two-capacitor circuit: a fast
//          ~80 ms recovery blending toward a ~1.5 s envelope under sustained
//          compression.
//
// Both modes are stereo-linked (max of |L|,|R|) and smooth gain reduction in
// the dB domain with branching attack/release one-poles (Giannoulis et al.
// 2012). Makeup gain is smoothed per-sample (~10 ms) against zipper noise.
// Gain reduction is posted on the port (~31 Hz, max-in-window, bare number in
// dB) for UI metering; messages are suppressed while idle.

const METER_INTERVAL_BLOCKS = 12; // 12 × 128 frames ≈ 31 Hz at 48 kHz
const KNEE_DB = 6; // vca soft-knee width
const DB_EPS = 1e-30; // kills log10(0) and detector denormals

// Read in place of a disconnected input, so the sample loop indexes a buffer
// unconditionally instead of testing for null 128 times a block. Sized to the
// render quantum on first use and reused thereafter; the quantum is 128 and
// fixed, so the grow branch never runs twice.
let SILENCE = new Float32Array(128);

class HardwareCompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      // Actual ratio (not an index); >= 100 means "all buttons in" (fet).
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 100, automationRate: 'k-rate' },
      // Seconds. fet uses 20 µs – 0.8 ms, vca 0.1 – 30 ms; range covers both.
      { name: 'attack', defaultValue: 0.003, minValue: 0.00002, maxValue: 0.03, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.3, minValue: 0.05, maxValue: 1.2, automationRate: 'k-rate' },
      { name: 'autoRelease', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'makeup', defaultValue: 0, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.fet = !!(options && options.processorOptions && options.processorOptions.mode === 'fet');
    this.gr = 0; // current gain reduction, dB (>= 0)
    this.grSlow = 0; // slow companion envelope of gr, dB
    this.gPrev = 1; // previous sample's linear comp gain (fet feedback tap)
    this.mk = 1; // smoothed linear makeup gain
    // DC blocker state, one pair per channel (fet saturation is asymmetric).
    // Scalars rather than arrays: the loop reads and writes them twice per
    // sample per channel, where a property-plus-index lookup is pure overhead.
    this.dcX0 = 0;
    this.dcY0 = 0;
    this.dcX1 = 0;
    this.dcY1 = 0;
    this.grMax = 0; // meter: max gr in the current window
    this.blockCount = 0;
    this.lastPosted = 0;

    // Functions of the sample rate alone. The rate cannot change under a live
    // processor, so these are built once instead of per block (REQ-6).
    const sr = sampleRate;
    this.mkA = Math.exp(-1 / (0.01 * sr)); // ~10 ms makeup smoothing
    this.dcR = 1 - (2 * Math.PI * 10) / sr; // 10 Hz DC blocker pole

    // Coefficient memo (REQ-6/7). Everything below is a function of the k-rate
    // params alone, so it survives until one of them moves — a knob turn, not a
    // block boundary. Keys seeded NaN so the first block always computes (NaN
    // compares unequal to everything, including itself).
    this.kThreshold = NaN;
    this.kRatio = NaN;
    this.kAttack = NaN;
    this.kRelease = NaN;
    this.kAuto = NaN;
    this.kMakeup = NaN;
    this.aA = 0;
    this.aR = 0;
    this.aSlow = 0;
    this.aRLong = 0;
    this.aRFast = 0;
    this.slope = 0;
    this.all = false;
    this.blend = false;
    this.mkT = 1;
  }

  /**
   * Recompute the k-rate-derived coefficients, but only when one of the six
   * params actually moved. The expressions are byte-for-byte the ones that used
   * to run per block: a coefficient that came out different in the last bit
   * would be a sound change, not an optimisation (REQ-7).
   */
  updateCoefficients(threshold, ratio, attack, release, autoRaw, makeupDb) {
    if (
      threshold === this.kThreshold && ratio === this.kRatio &&
      attack === this.kAttack && release === this.kRelease &&
      autoRaw === this.kAuto && makeupDb === this.kMakeup
    ) {
      return;
    }
    this.kThreshold = threshold;
    this.kRatio = ratio;
    this.kAttack = attack;
    this.kRelease = release;
    this.kAuto = autoRaw;
    this.kMakeup = makeupDb;

    const sr = sampleRate;
    const fet = this.fet;
    const auto = autoRaw >= 0.5;

    // Attack clamped to at least one sample (20 µs is sub-sample at 48 kHz).
    this.aA = attack * sr <= 1 ? 0 : Math.exp(-1 / (attack * sr));
    const aR = Math.exp(-1 / (release * sr));
    this.aR = aR;
    this.all = fet && ratio >= 100;
    this.slope = this.all ? 1 - 1 / 1000 : 1 - 1 / ratio;
    // Program-dependent release: fet blends knob ↔ 5× knob on a ~600 ms
    // companion envelope; vca auto blends 80 ms ↔ 1.5 s on a ~1.5 s one.
    this.aSlow = Math.exp(-1 / ((fet ? 0.6 : 1.5) * sr));
    this.aRLong = fet ? Math.exp(-1 / (release * 5 * sr)) : Math.exp(-1 / (1.5 * sr));
    this.aRFast = fet ? aR : auto ? Math.exp(-1 / (0.08 * sr)) : aR;
    this.blend = fet || auto;
    this.mkT = Math.pow(10, makeupDb / 20);
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const threshold = params.threshold[0];
    this.updateCoefficients(
      threshold,
      params.ratio[0],
      params.attack[0],
      params.release[0],
      params.autoRelease[0],
      params.makeup[0],
    );

    const fet = this.fet;
    const all = this.all;
    const slope = this.slope;
    const aA = this.aA;
    const aSlow = this.aSlow;
    const aRLong = this.aRLong;
    const aRFast = this.aRFast;
    const blend = this.blend;
    const mkT = this.mkT;
    const mkA = this.mkA;
    const dcR = this.dcR;

    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    const n = outL.length;
    // Whether there is signal to read is fixed for the block, so the loop reads
    // a zero-filled stand-in rather than testing for null on every sample.
    if (SILENCE.length < n) SILENCE = new Float32Array(n);
    const srcL = inL || SILENCE;
    const srcR = inR || SILENCE;

    let gr = this.gr;
    let grSlow = this.grSlow;
    let gPrev = this.gPrev;
    let mk = this.mk;
    let grMax = this.grMax;
    let dcX0 = this.dcX0;
    let dcY0 = this.dcY0;
    let dcX1 = this.dcX1;
    let dcY1 = this.dcY1;

    for (let i = 0; i < n; i++) {
      const xL = srcL[i];
      const xR = srcR[i];

      // Stereo-linked sidechain. fet = feedback (post-gain), vca = feed-forward.
      let sc = Math.max(Math.abs(xL), Math.abs(xR));
      if (fet) sc *= gPrev;
      const lv = 20 * Math.log10(sc + DB_EPS);

      // Gain computer (static curve, dB in → desired reduction out).
      const over = lv - threshold;
      let gDes;
      if (fet) {
        gDes = over > 0 ? over * slope : 0;
        if (all && over > 0) gDes += Math.min(10, 0.12 * over * over);
      } else if (2 * over < -KNEE_DB) {
        gDes = 0;
      } else if (2 * over <= KNEE_DB) {
        const t = over + KNEE_DB / 2;
        gDes = (slope * t * t) / (2 * KNEE_DB);
      } else {
        gDes = over * slope;
      }

      // Branching dB-domain smoothing + slow companion envelope.
      grSlow += (1 - aSlow) * (gr - grSlow);
      if (gDes > gr) {
        gr = gDes + (gr - gDes) * aA;
      } else {
        let aEff = aRFast;
        if (blend) {
          const w = grSlow / (grSlow + 6);
          aEff = aRFast + (aRLong - aRFast) * w;
        }
        gr = gDes + (gr - gDes) * aEff;
      }

      const g = Math.pow(10, -gr / 20);
      gPrev = g;
      mk += (1 - mkA) * (mkT - mk);
      let yL = xL * g * mk;
      let yR = xR * g * mk;

      if (fet) {
        // FET saturation — drive rides the gain reduction; the +0.02
        // asymmetry adds 2nd harmonic (and DC, removed below).
        const d = (1 + gr * 0.05) * (all ? 2 : 1);
        yL = Math.tanh(d * (yL + 0.02)) / d;
        yR = Math.tanh(d * (yR + 0.02)) / d;
        const bL = yL - dcX0 + dcR * dcY0;
        dcX0 = yL;
        dcY0 = bL;
        yL = bL;
        const bR = yR - dcX1 + dcR * dcY1;
        dcX1 = yR;
        dcY1 = bR;
        yR = bR;
      }

      outL[i] = yL;
      if (outR) outR[i] = yR;
      if (gr > grMax) grMax = gr;
    }

    // Flush denormal-range envelope state.
    if (gr < 1e-6) gr = 0;
    if (grSlow < 1e-6) grSlow = 0;
    this.gr = gr;
    this.grSlow = grSlow;
    this.gPrev = gPrev;
    this.mk = mk;
    this.dcX0 = dcX0;
    this.dcY0 = dcY0;
    this.dcX1 = dcX1;
    this.dcY1 = dcY1;

    if (++this.blockCount >= METER_INTERVAL_BLOCKS) {
      if (grMax > 0.01 || this.lastPosted > 0.01) {
        this.port.postMessage(grMax);
        this.lastPosted = grMax;
      }
      grMax = 0;
      this.blockCount = 0;
    }
    this.grMax = grMax;

    return true;
  }
}

registerProcessor('hardware-compressor', HardwareCompressorProcessor);
