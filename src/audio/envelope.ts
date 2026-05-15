/**
 * Control-signal ADSR envelope.
 *
 * Internally drives a GainNode (fed by a constant-1 source) so the output is
 * an audio-rate signal in [0, peak]. Route this signal into any AudioParam
 * (amp VCA, filter cutoff, etc.) via `envelope.out.connect(param)`.
 */
export class Envelope {
  readonly out: GainNode;
  private readonly source: ConstantSourceNode;

  private attack = 0.005;
  private decay = 0.1;
  private sustain = 0.7;
  private release = 0.2;

  constructor(private readonly ctx: AudioContext) {
    this.source = ctx.createConstantSource();
    this.source.offset.value = 1;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.source.connect(this.out);
    this.source.start();
  }

  setAttack(v: number): void { this.attack = Math.max(0.001, v); }
  setDecay(v: number): void { this.decay = Math.max(0.001, v); }
  setSustain(v: number): void { this.sustain = Math.max(0, Math.min(1, v)); }
  setRelease(v: number): void { this.release = Math.max(0.001, v); }

  /** Trigger attack/decay phases. Picks up from current value (key retrigger). */
  trigger(when: number, peak = 1): void {
    const t = Math.max(when, this.ctx.currentTime);
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(peak, t, this.attack / 3);
    g.setTargetAtTime(peak * this.sustain, t + this.attack, this.decay / 3);
  }

  /** Trigger release phase. */
  release_(when: number): void {
    const t = Math.max(when, this.ctx.currentTime);
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(0, t, this.release / 3);
  }

  /** Approximate time at which release will be effectively silent. */
  releaseDuration(): number {
    return this.release * 5; // ~5 time constants → effectively zero
  }
}
