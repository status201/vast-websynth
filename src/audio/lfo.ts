import { rampTo, RAMP_MEDIUM } from './param-utils';

const WAVE_TYPES: OscillatorType[] = ['sine', 'triangle', 'sawtooth', 'square'];

export const enum LfoDest {
  Off = 0,
  Cutoff = 1,
  Pitch = 2,
  Amp = 3,
  Pulse = 4,
}

/**
 * Global LFO. Exposes three pre-scaled output nodes corresponding to its
 * three destinations: pitch (cents), cutoff (semitones), amp (linear).
 * Only the active destination's gain is non-zero — the others are silent.
 * Voices connect each output to the matching AudioParam (osc detune,
 * filter cutoffNote, tremolo gain).
 */
export class LFO {
  readonly toPitch: GainNode;
  readonly toCutoff: GainNode;
  readonly toAmp: GainNode;

  private readonly osc: OscillatorNode;
  private amount = 0;
  private dest: LfoDest = LfoDest.Off;

  constructor(private readonly ctx: AudioContext) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.value = 4;

    this.toPitch = ctx.createGain();
    this.toCutoff = ctx.createGain();
    this.toAmp = ctx.createGain();
    this.toPitch.gain.value = 0;
    this.toCutoff.gain.value = 0;
    this.toAmp.gain.value = 0;

    this.osc.connect(this.toPitch);
    this.osc.connect(this.toCutoff);
    this.osc.connect(this.toAmp);

    this.osc.start();
  }

  setRate(hz: number): void {
    rampTo(this.osc.frequency, hz, this.ctx, RAMP_MEDIUM);
  }

  setWave(idx: number): void {
    const t = WAVE_TYPES[Math.max(0, Math.min(WAVE_TYPES.length - 1, Math.round(idx)))];
    if (t) this.osc.type = t;
  }

  setAmount(a: number): void {
    this.amount = Math.max(0, Math.min(1, a));
    this.update();
  }

  setDest(d: number): void {
    this.dest = Math.round(d);
    this.update();
  }

  private update(): void {
    const t = this.ctx.currentTime;
    // Pitch: ±1200 cents (one octave) at full depth
    rampTo(this.toPitch.gain, this.dest === LfoDest.Pitch ? this.amount * 1200 : 0, this.ctx, RAMP_MEDIUM);
    // Cutoff: ±24 semitones (two octaves) at full depth
    rampTo(this.toCutoff.gain, this.dest === LfoDest.Cutoff ? this.amount * 24 : 0, this.ctx, RAMP_MEDIUM);
    // Amp: ±50% modulation at full depth (added to tremolo VCA's base 1.0)
    rampTo(this.toAmp.gain, this.dest === LfoDest.Amp ? this.amount * 0.5 : 0, this.ctx, RAMP_MEDIUM);
  }
}
