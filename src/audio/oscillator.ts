const WAVE_TYPES: OscillatorType[] = ['sine', 'triangle', 'sawtooth', 'square'];

/**
 * Long-lived oscillator wrapper. OscillatorNode is one-shot, so we start it
 * once and gate audibility downstream via the amp VCA.
 */
export class Osc {
  readonly out: GainNode;
  private readonly osc: OscillatorNode;
  private octave = 0;
  private detuneCents = 0;

  constructor(private readonly ctx: AudioContext) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 440;
    this.osc.detune.value = 0;

    this.out = ctx.createGain();
    this.out.gain.value = 0.7;
    this.osc.connect(this.out);
    this.osc.start();
  }

  /** Set carrier frequency. Optional glide via setTargetAtTime. */
  setFrequency(hz: number, when: number, glideSec: number): void {
    const f = this.osc.frequency;
    if (glideSec <= 0.001) {
      f.cancelScheduledValues(when);
      f.setValueAtTime(hz, when);
    } else {
      f.cancelScheduledValues(when);
      f.setTargetAtTime(hz, when, glideSec / 3);
    }
  }

  setWave(idx: number): void {
    const t = WAVE_TYPES[Math.max(0, Math.min(WAVE_TYPES.length - 1, Math.round(idx)))];
    if (t) this.osc.type = t;
  }

  setOctave(o: number): void {
    this.octave = o;
    this.applyDetune();
  }

  setDetuneCents(c: number): void {
    this.detuneCents = c;
    this.applyDetune();
  }

  setLevel(v: number): void {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** The OscillatorNode's detune AudioParam — for connecting LFO / pitch bend. */
  get detuneParam(): AudioParam {
    return this.osc.detune;
  }

  private applyDetune(): void {
    // Octave + fine detune. LFO/pitchBend modulate via separate AudioNode → detune connection.
    const cents = this.octave * 1200 + this.detuneCents;
    this.osc.detune.setTargetAtTime(cents, this.ctx.currentTime, 0.005);
  }
}
