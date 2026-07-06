// 4-pole Moog-style ladder lowpass with per-stage saturation.
// Cutoff is expressed as a MIDI note number (linear-in-pitch),
// so envelope/LFO modulators can sum in semitones via Web Audio's
// AudioParam input summation.
//
// Saturation: a cheap, bounded, odd-symmetric rational nonlinearity is applied
// at the input *and* at every pole — the transistor-ladder character that gives
// smooth overdrive and self-limiting self-oscillation. `sat'(0) === 1`, so at
// low level / low resonance the response matches the linear ladder (existing
// presets are preserved). The feedback is taken from saturated states so the
// loop is bounded — it cannot run away to NaN regardless of resonance.

// Bounded to ±1, slope 1 at the origin. Cheaper than tanh (no transcendental).
function sat(x) {
  return x / (1 + Math.abs(x));
}

// Make-up gain to offset the passband level lost as resonance rises.
const RES_MAKEUP = 0.25;

class LadderFilterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'cutoffNote',
        defaultValue: 110,
        minValue: 0,
        maxValue: 135,
        automationRate: 'a-rate',
      },
      {
        name: 'resonance',
        defaultValue: 0,
        minValue: 0,
        maxValue: 4.2,
        automationRate: 'a-rate',
      },
      {
        name: 'drive',
        defaultValue: 1,
        minValue: 0.5,
        maxValue: 8,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this.state = [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    // Idle gating: the voice's oscillators feed us forever and the amp VCA is
    // downstream, so silence detection can never fire — the host posts an
    // explicit active flag instead. Defaults ON so a lost message can only
    // cost CPU, never silence a note. Any step is masked by the closed VCA.
    this.active = true;
    this.port.onmessage = (e) => {
      const on = !!e.data;
      if (!on) {
        // Zero state so reactivation starts from a clean filter.
        for (const s of this.state) if (s) s.fill(0);
      }
      this.active = on;
    };
    // Block-constant cutoff cache (REQ-11): the pole coefficient `g` only
    // depends on the cutoff value, so when a block is all-equal we compute it
    // once and reuse it across blocks until the value changes. NaN forces the
    // first compute.
    this.lastCutoff = NaN;
    this.lastG = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    if (!this.active) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    const channels = output.length;
    const sr = sampleRate;
    const drive = params.drive[0];
    const cutoffArr = params.cutoffNote;
    const resArr = params.resonance;
    const resStatic = resArr.length === 1;

    // Block-constant cutoff hoist (REQ-11): env + LFO are always wired to
    // cutoffNote, so the host hands us a full 128-length array — but it is
    // all-equal whenever the cutoff is held/unmodulated (the common case). Then
    // the pole coefficient `g` (a Math.pow + Math.exp) is computed once per
    // block and cached across blocks, instead of per sample × channel. Full
    // scan with early exit, so a genuinely modulated block pays ~1 compare and
    // falls back to the per-sample path below.
    const c0 = cutoffArr[0];
    let cutoffConst = true;
    for (let i = 1; i < cutoffArr.length; i++) {
      if (cutoffArr[i] !== c0) { cutoffConst = false; break; }
    }
    let gBlock = 0;
    if (cutoffConst) {
      if (c0 !== this.lastCutoff) {
        this.lastCutoff = c0;
        // MIDI note → Hz (clamped < Nyquist) → one-pole coefficient. Identical
        // expression to the per-sample path, so a constant block is bit-exact.
        const freq = 440 * Math.pow(2, (c0 - 69) / 12);
        const fNorm = Math.min(Math.max(freq / sr, 0.0001), 0.49);
        this.lastG = 1 - Math.exp(-2 * Math.PI * fNorm);
      }
      gBlock = this.lastG;
    }

    for (let ch = 0; ch < channels; ch++) {
      const inCh = input && input[ch] ? input[ch] : null;
      const outCh = output[ch];
      let s = this.state[ch];
      if (!s) {
        s = [0, 0, 0, 0, 0];
        this.state[ch] = s;
      }

      for (let i = 0; i < outCh.length; i++) {
        const res = resStatic ? resArr[0] : resArr[i];

        // One-pole coefficient: hoisted (constant block) or per-sample. MIDI
        // note → Hz, clamped just under Nyquist. Same math either way.
        let g;
        if (cutoffConst) {
          g = gBlock;
        } else {
          const freq = 440 * Math.pow(2, (cutoffArr[i] - 69) / 12);
          const fNorm = Math.min(Math.max(freq / sr, 0.0001), 0.49);
          g = 1 - Math.exp(-2 * Math.PI * fNorm);
        }

        const x = inCh ? inCh[i] : 0;

        // Half-sample feedback delay smooths self-oscillation; taking it from
        // saturated states bounds the loop (|fb| < 1, so it can't run away).
        const fb = (sat(s[3]) + sat(s[4])) * 0.5;

        // Input drive + saturation, then a saturated one-pole per stage.
        // `v` carries each stage's saturated output into the next stage's input.
        let v = sat((x - res * fb) * drive);
        s[0] += g * (v - sat(s[0]));
        v = sat(s[0]);
        s[1] += g * (v - sat(s[1]));
        v = sat(s[1]);
        s[2] += g * (v - sat(s[2]));
        v = sat(s[2]);
        s[4] = s[3];
        s[3] += g * (v - sat(s[3]));

        // Level compensation as resonance rises (filter loses passband gain)
        outCh[i] = s[3] * (1 + res * RES_MAKEUP);
      }
    }
    return true;
  }
}

registerProcessor('ladder-filter', LadderFilterProcessor);
