// Reverse delay (delay-types.md REQ-each-type-has-its-own-topology). The input
// is written into a ring buffer; read heads play windows of length TIME
// backwards, starting at the moment each window opens, so every window is the
// last TIME of audio turned around. The wrapper around it owns the dry path and
// the mix, so this outputs the reversed signal only.
//
// It is a worklet because a DelayNode can only read forwards. Tuned to ADR-010:
// musical, stable, cheap — in that order.
//
//  - A new window opens when the last one starts to close, and the two cross
//    over linearly. The opening hands every head still sounding a fade from its
//    current gain to 0 over the NEW crossover, as the new head fades in over the
//    same length, so the head gains sum to 1 at every sample even while TIME or
//    CHAR move, and at most two heads ever sound. CHAR sets the crossover as a
//    share of the window: short and punchy to long swells.
//  - TIME and CHAR are read when a window opens, so moving them never zippers.
//  - A head reads `2k + 1` samples behind the writer at step k, so the buffer
//    holds two of the longest windows.
//  - Feedback is clamped and soft-saturated, a non-finite input reads as 0, and
//    denormals are flushed, so the output is bounded for any input at any
//    setting (REQ-every-type-is-bounded).
//  - Channel-transparent up to two channels, the heads shared between them. A
//    disconnected input reads as silence, so a bypass drain empties the buffer.

const MIN_TIME_S = 0.02;
const MAX_TIME_S = 2;
const MAX_FEEDBACK = 0.95;
const MAX_CHANNELS = 2;
const HEADS = 3; // two overlap at most (see open()); the third is spare
const FADE_MIN = 0.05; // crossover share of the window at CHAR 0
const FADE_MAX = 0.5; // ... and at CHAR 1: the windows are all crossover
const SMOOTH_S = 0.01; // feedback one-pole
const DENORMAL = 1e-20;

let SILENCE = new Float32Array(128);

const clamp = (v, lo, hi) => (v > lo ? (v < hi ? v : hi) : lo);

class ReverseDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 0.35, minValue: MIN_TIME_S, maxValue: MAX_TIME_S, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0, minValue: 0, maxValue: MAX_FEEDBACK, automationRate: 'k-rate' },
      { name: 'char', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const need = Math.ceil(2 * MAX_TIME_S * sampleRate) + 256;
    let size = 1;
    while (size < need) size <<= 1;
    this.mask = size - 1;
    this.bufs = [];
    for (let c = 0; c < MAX_CHANNELS; c++) this.bufs.push(new Float32Array(size));
    this.chans = 0;
    this.w = 0;
    this.heads = [];
    // `k`: steps read so far. `fade`: the fade-in. Once the next window opens,
    // `outAt`/`outG`/`outLen`: the step, gain and length its fade-out starts from.
    for (let h = 0; h < HEADS; h++) {
      this.heads.push({ on: false, start: 0, k: 0, fade: 1, outAt: 0, outG: 0, outLen: 0 });
    }
    // The furthest a head may read: `2k + 1` behind the writer must stay in the buffer.
    this.maxK = Math.floor(MAX_TIME_S * sampleRate);
    this.untilNext = 0;
    this.fb = -1;
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sampleRate));
    this.y = new Float32Array(MAX_CHANNELS);
    // Each channel's input this block, refilled in place: process() allocates nothing.
    this.ins = new Array(MAX_CHANNELS).fill(SILENCE);
  }

  /** A head's gain at its current step. */
  gain(h) {
    if (h.outLen > 0) return h.outG * (1 - (h.k - h.outAt) / h.outLen);
    return h.k < h.fade ? h.k / h.fade : 1;
  }

  /**
   * Open a window at write index `w`, fading in over `fade`. Every head still
   * sounding fades from its current gain to 0 over that same `fade`, so the gains,
   * which summed to 1, keep summing to 1 (Σg·(1 − t) + t). The next window opens
   * `len - fade >= fade` later, by when they have all closed: a free head is
   * always there, and the lowest-gain steal is only a backstop.
   */
  open(w, fade) {
    let pick = null;
    for (const h of this.heads) {
      if (!h.on) { if (!pick || pick.on) pick = h; continue; }
      const g = this.gain(h);
      h.outG = g;
      h.outAt = h.k;
      // Never read past the buffer, which only a TIME raise mid-window approaches.
      const room = this.maxK - h.k;
      h.outLen = fade < room ? fade : room > 1 ? room : 1;
      if (!pick || (pick.on && g < pick.outG)) pick = h;
    }
    pick.on = true;
    pick.start = w;
    pick.k = 0;
    pick.fade = fade;
    pick.outLen = 0;
  }

  process(inputs, outputs, params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const input = inputs[0];
    const n = output[0].length;
    if (SILENCE.length < n) SILENCE = new Float32Array(n);

    const len = Math.max(2, Math.round(clamp(params.time[0], MIN_TIME_S, MAX_TIME_S) * sampleRate));
    const share = FADE_MIN + (FADE_MAX - FADE_MIN) * clamp(params.char[0], 0, 1);
    const fade = Math.max(1, Math.floor(share * len));
    const fbT = clamp(params.feedback[0], 0, MAX_FEEDBACK);
    if (this.fb < 0) this.fb = fbT;

    const chans = output.length < MAX_CHANNELS ? output.length : MAX_CHANNELS;
    // A channel coming back into use starts from silence, not old audio.
    for (let c = this.chans; c < chans; c++) this.bufs[c].fill(0);
    this.chans = chans;
    const ins = this.ins;
    for (let c = 0; c < chans; c++) {
      ins[c] = input && input.length > 0 ? input[c < input.length ? c : input.length - 1] : SILENCE;
    }

    const mask = this.mask;
    const heads = this.heads;
    const y = this.y;
    const k = this.k;
    let fb = this.fb;
    let w = this.w;
    for (let i = 0; i < n; i++) {
      if (this.untilNext <= 0) {
        this.open(w, fade);
        this.untilNext = len - fade;
      }
      this.untilNext--;
      fb += (fbT - fb) * k;

      for (let c = 0; c < chans; c++) y[c] = 0;
      for (let h = 0; h < HEADS; h++) {
        const hd = heads[h];
        if (!hd.on) continue;
        const j = hd.k;
        const g = this.gain(hd);
        const r = (hd.start - 1 - j) & mask;
        for (let c = 0; c < chans; c++) y[c] += g * this.bufs[c][r];
        hd.k++;
        if (hd.outLen > 0 && hd.k - hd.outAt >= hd.outLen) hd.on = false;
      }

      for (let c = 0; c < chans; c++) {
        let x = ins[c][i];
        if (!(x > -1e9 && x < 1e9)) x = 0; // NaN, ±Infinity
        const out = y[c];
        let v = x + fb * (out / (1 + (out < 0 ? -out : out)));
        if (v > -DENORMAL && v < DENORMAL) v = 0;
        this.bufs[c][w & mask] = v;
        output[c][i] = out;
      }
      w = (w + 1) & mask;
    }
    this.w = w;
    this.fb = fb;
    return true;
  }
}

registerProcessor('reverse-delay', ReverseDelayProcessor);
