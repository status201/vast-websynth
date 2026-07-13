/**
 * Control-signal ADSR envelope.
 *
 * Internally drives a GainNode (fed by a constant-1 source) so the output is
 * an audio-rate signal in [0, peak]. Route this signal into any AudioParam
 * (amp VCA, filter cutoff, etc.) via `envelope.out.connect(param)`.
 *
 * Scheduling is future-time-safe (envelopes.md REQ-4): the transport schedules
 * a step's attack *and* its gate-end release on the same tick, both up to the
 * look-ahead in the future. Anchoring a phase change at the live param value
 * (`gain.value` — the value *now*) pins a stale snapshot at the scheduled time
 * and steps the output discontinuously (an audible click). Instead the
 * envelope tracks every event it schedules and anchors at the value the curve
 * reaches at that time. That model is only truthful while this class is the
 * sole writer of `out.gain` — external cuts go through `cutFast`.
 */

/** A tracked automation event: an anchor (`value`) or a target segment. */
interface EnvEvent {
  time: number;
  value?: number;   // setValueAtTime anchor
  target?: number;  // setTargetAtTime destination …
  tau?: number;     // … and its time constant
}

export class Envelope {
  readonly out: GainNode;
  private readonly source: ConstantSourceNode;

  private attack = 0.005;
  private decay = 0.1;
  private sustain = 0.7;
  private release = 0.2;

  // Chronological mirror of everything scheduled on out.gain.
  private events: EnvEvent[] = [{ time: 0, value: 0 }];

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

  /** Trigger attack/decay phases. Picks up from the curve's value at `when`. */
  trigger(when: number, peak = 1): void {
    const t = this.anchor(when);
    this.setTarget(peak, t, this.attack / 3);
    this.setTarget(peak * this.sustain, t + this.attack, this.decay / 3);
  }

  /** Trigger release phase. */
  release_(when: number): void {
    const t = this.anchor(when);
    this.setTarget(0, t, this.release / 3);
  }

  /** Fast cut to silence (voice stealing) — the external-cut entry point. */
  cutFast(when: number, tau = 0.003): void {
    const t = this.anchor(when);
    this.setTarget(0, t, tau);
  }

  /** Approximate time at which release will be effectively silent. */
  releaseDuration(): number {
    return this.release * 5; // ~5 time constants → effectively zero
  }

  /**
   * Cancel from `t` and pin the value the curve reaches at `t` (REQ-4).
   * Returns the effective time (`max(when, now)`).
   */
  private anchor(when: number): number {
    const now = this.ctx.currentTime;
    const t = Math.max(when, now);
    // Mirror cancelScheduledValues: drop tracked events at/after t, then prune
    // history the next queries can never reach (t is always >= now, so only
    // events from the last anchor at/before now onward still matter).
    this.events = this.events.filter((e) => e.time < t);
    let keepFrom = 0;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      if (e.value !== undefined && e.time <= now) keepFrom = i;
    }
    this.events = this.events.slice(keepFrom);
    const v = this.valueAt(t);
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(v, t);
    this.events.push({ time: t, value: v });
    return t;
  }

  private setTarget(target: number, time: number, tau: number): void {
    this.out.gain.setTargetAtTime(target, time, tau);
    this.events.push({ time, target, tau });
  }

  /** Envelope value the tracked curve reaches at time `t`. */
  private valueAt(t: number): number {
    let v = 0;
    let at = 0;
    let seg: { target: number; tau: number } | null = null;
    for (const e of this.events) {
      if (e.time > t) break;
      // Advance under the running target segment up to this event.
      if (seg) v = seg.target + (v - seg.target) * Math.exp(-(e.time - at) / seg.tau);
      at = e.time;
      if (e.value !== undefined) { v = e.value; seg = null; }
      else { seg = { target: e.target!, tau: e.tau! }; }
    }
    if (seg && t > at) v = seg.target + (v - seg.target) * Math.exp(-(t - at) / seg.tau);
    return v;
  }
}
