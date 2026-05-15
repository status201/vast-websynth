// 4-pole Moog-style ladder lowpass with tanh saturation.
// Cutoff is expressed as a MIDI note number (linear-in-pitch),
// so envelope/LFO modulators can sum in semitones via Web Audio's
// AudioParam input summation.

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
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channels = output.length;
    const sr = sampleRate;
    const drive = params.drive[0];
    const cutoffArr = params.cutoffNote;
    const resArr = params.resonance;
    const cutoffStatic = cutoffArr.length === 1;
    const resStatic = resArr.length === 1;

    for (let ch = 0; ch < channels; ch++) {
      const inCh = input && input[ch] ? input[ch] : null;
      const outCh = output[ch];
      let s = this.state[ch];
      if (!s) {
        s = [0, 0, 0, 0, 0];
        this.state[ch] = s;
      }

      for (let i = 0; i < outCh.length; i++) {
        const cutoffNote = cutoffStatic ? cutoffArr[0] : cutoffArr[i];
        const res = resStatic ? resArr[0] : resArr[i];

        // MIDI note → Hz, clamped just under Nyquist
        const freq = 440 * Math.pow(2, (cutoffNote - 69) / 12);
        const fNorm = Math.min(Math.max(freq / sr, 0.0001), 0.49);
        // One-pole coefficient (bilinear-style)
        const g = 1 - Math.exp(-2 * Math.PI * fNorm);

        const x = inCh ? inCh[i] : 0;

        // Half-sample feedback delay smooths self-oscillation
        const fb = (s[3] + s[4]) * 0.5;
        let v = (x - res * fb) * drive;
        v = Math.tanh(v);

        s[0] += g * (v - s[0]);
        s[1] += g * (s[0] - s[1]);
        s[2] += g * (s[1] - s[2]);
        s[4] = s[3];
        s[3] += g * (s[2] - s[3]);

        // Slight level compensation as resonance rises (filter loses gain)
        outCh[i] = s[3] * (1 + res * 0.25);
      }
    }
    return true;
  }
}

registerProcessor('ladder-filter', LadderFilterProcessor);
