// Flanger (flanger.md). A short delay line swept by a triangle LFO, fed back
// through a soft saturator. The wrapper around it owns the dry path and the
// mix, so this outputs the delayed signal only.
//
// It is a worklet because Web Audio clamps a DelayNode inside a cycle to one
// render quantum (~2.7 ms at 48 kHz), and the jet sweep lives well under that
// (REQ-the-flanger-is-a-worklet-delay-line). Tuned to ADR-010: musical,
// stable, cheap — in that order.
//
//  - The delay sweeps exponentially, so the notches move evenly in pitch
//    (REQ-the-flanger-sweeps-in-pitch).
//  - Feedback is clamped and saturated, a non-finite input reads as 0, and
//    denormals are flushed, so the output is bounded for any input at any
//    setting (REQ-the-flanger-feedback-is-bounded).
//  - Channel-transparent: one output channel per input channel, up to two,
//    each with its own buffer. A disconnected input reads as silence, so a
//    bypass drain empties the buffer whichever way the cut arrives.

const MIN_DELAY_S = 0.00025; // the top of the sweep: first notch near 2 kHz
const SPAN_OCTAVES = 4.5; // how far down depth 1 reaches: ~5.7 ms
const MAX_FEEDBACK = 0.9;
const MAX_CHANNELS = 2;
const SMOOTH_S = 0.01; // depth/feedback one-pole, so a knob turn never steps the read head
const DENORMAL = 1e-20;
const LN2 = Math.LN2;

// Read in place of a disconnected input; sized to the render quantum on first
// use. Also the per-sample delay and feedback scratch, grown once.
let SILENCE = new Float32Array(128);

const clamp = (v, lo, hi) => (v > lo ? (v < hi ? v : hi) : lo);

class FlangerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.2, minValue: 0.01, maxValue: 20, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0, minValue: 0, maxValue: MAX_FEEDBACK, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const maxSamples = Math.ceil(MIN_DELAY_S * Math.pow(2, SPAN_OCTAVES) * sampleRate) + 4;
    let size = 1;
    while (size < maxSamples) size <<= 1;
    this.mask = size - 1;
    this.bufs = [];
    for (let c = 0; c < MAX_CHANNELS; c++) this.bufs.push(new Float32Array(size));
    this.chans = 0; // channels processed last block
    this.w = 0; // write index, shared by every channel
    this.phase = 0; // LFO phase, 0..1
    this.depth = -1; // smoothed; seeded from the first block's param
    this.fb = 0;
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sampleRate));
    this.minSamples = MIN_DELAY_S * sampleRate;
    this.dly = new Float32Array(128); // per-sample delay, in samples
    this.fbs = new Float32Array(128); // per-sample feedback
  }

  process(inputs, outputs, params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const input = inputs[0];
    const n = output[0].length;
    if (SILENCE.length < n) SILENCE = new Float32Array(n);
    if (this.dly.length < n) {
      this.dly = new Float32Array(n);
      this.fbs = new Float32Array(n);
    }

    const inc = clamp(params.rate[0], 0.01, 20) / sampleRate;
    const depthT = clamp(params.depth[0], 0, 1);
    const fbT = clamp(params.feedback[0], 0, MAX_FEEDBACK);
    if (this.depth < 0) {
      this.depth = depthT;
      this.fb = fbT;
    }

    // One LFO for every channel: the sweep is computed once per sample.
    const k = this.k;
    const span = SPAN_OCTAVES * LN2;
    let phase = this.phase;
    let depth = this.depth;
    let fb = this.fb;
    const dly = this.dly;
    const fbs = this.fbs;
    for (let i = 0; i < n; i++) {
      depth += (depthT - depth) * k;
      fb += (fbT - fb) * k;
      const tri = phase < 0.5 ? 2 * phase : 2 - 2 * phase;
      dly[i] = this.minSamples * Math.exp(span * depth * tri);
      fbs[i] = fb;
      phase += inc;
      if (phase >= 1) phase -= 1;
    }
    this.phase = phase;
    this.depth = depth;
    this.fb = fb;

    const mask = this.mask;
    const w0 = this.w;
    const chans = output.length < MAX_CHANNELS ? output.length : MAX_CHANNELS;
    // A channel coming back into use (the synth bus going stereo while a pan is
    // off centre) starts from silence, not from the audio it held last time.
    for (let c = this.chans; c < chans; c++) this.bufs[c].fill(0);
    this.chans = chans;
    for (let c = 0; c < chans; c++) {
      const inp = input && input.length > 0 ? input[c < input.length ? c : input.length - 1] : SILENCE;
      const out = output[c];
      const buf = this.bufs[c];
      let w = w0;
      for (let i = 0; i < n; i++) {
        let x = inp[i];
        if (!(x > -1e9 && x < 1e9)) x = 0; // NaN, ±Infinity
        // Read before the write: the shortest delay is several samples, so the
        // two interpolation taps are always in the past.
        const pos = w - dly[i];
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const y = buf[i0 & mask] * (1 - frac) + buf[(i0 + 1) & mask] * frac;
        const f = fbs[i];
        let v = x + f * (y / (1 + (y < 0 ? -y : y)));
        if (v > -DENORMAL && v < DENORMAL) v = 0;
        buf[w & mask] = v;
        // The comb's broadband power gain is 1/(1 - f²): undo it, so FB
        // sharpens the resonance without raising the level.
        out[i] = y * Math.sqrt(1 - f * f);
        w++;
      }
    }
    this.w = (w0 + n) & mask;
    return true;
  }
}

registerProcessor('flanger', FlangerProcessor);
