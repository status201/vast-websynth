/**
 * Control-signal ADSR envelope.
 *
 * Internally drives a GainNode (fed by a constant-1 source) so the output is
 * an audio-rate signal in [0, peak]. Route this signal into any AudioParam
 * (amp VCA, filter cutoff, etc.) via `envelope.out.connect(param)`.
 *
 * Scheduling is future-time-safe (envelopes.md REQ-envelope-scheduling-is-future-time-safe): the transport schedules
 * a step's attack *and* its gate-end release on the same tick, both up to the
 * look-ahead in the future. Anchoring a phase change at the live param value
 * (`gain.value` — the value *now*) pins a stale snapshot at the scheduled time
 * and steps the output discontinuously (an audible click). Instead the
 * envelope tracks every event it schedules and anchors at the value the curve
 * reaches at that time. That model is only truthful while this class is the
 * sole writer of `out.gain` — external cuts go through `cutFast`.
 */

import { clamp01 } from '../utils/math';
// The phase shape is shared with the help graph (envelopes.md REQ-the-envelope-curve-is-one-pure-model).
import { approach, MIN_PHASE_SECONDS, phaseTau } from '../utils/envelope-curve';

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
  /**
   * The sounding strike, as it was struck — what `rescale` re-aims. Null when
   * never struck, or released or cut since: there is nothing to rescale then.
   * Its own phase times, so a knob turned since cannot move this note's phases.
   */
  private struck: {
    peak: number; attackEnd: number; attack: number; decay: number; sustain: number;
  } | null = null;

  constructor(private readonly ctx: AudioContext) {
    this.source = ctx.createConstantSource();
    this.source.offset.value = 1;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.source.connect(this.out);
    this.source.start();
  }

  setAttack(v: number): void { this.attack = Math.max(MIN_PHASE_SECONDS, v); }
  setDecay(v: number): void { this.decay = Math.max(MIN_PHASE_SECONDS, v); }
  setSustain(v: number): void { this.sustain = clamp01(v); }
  setRelease(v: number): void { this.release = Math.max(MIN_PHASE_SECONDS, v); }

  /** Trigger attack/decay phases. Picks up from the curve's value at `when`. */
  trigger(when: number, peak = 1): void {
    const t = this.anchor(when);
    const { attack, decay, sustain } = this;
    this.struck = { peak, attackEnd: t + attack, attack, decay, sustain };
    this.setTarget(peak, t, phaseTau(attack));
    this.setTarget(peak * sustain, t + attack, phaseTau(decay));
  }

  /**
   * Move a sounding envelope to the level a strike at `peak` would have at its
   * current phase, without a new attack (envelopes.md
   * REQ-a-continued-note-rescales-without-restarting). In the attack, the attack
   * aims at the new peak and the decay keeps its start; in the decay, the decay
   * aims at the new sustain on its own time constant; in the sustain, the level
   * moves there over `tau`. Nothing is scheduled at an unchanged peak, past the
   * attack at sustain 0, or on an envelope that is not sounding.
   */
  rescale(when: number, peak: number, tau: number): void {
    const s = this.struck;
    if (!s || peak === s.peak) return;
    const inAttack = Math.max(when, this.ctx.currentTime) < s.attackEnd;
    // Past the attack at sustain 0 the target is 0 at any peak: a pluck decays as struck.
    if (!inAttack && s.sustain === 0) { s.peak = peak; return; }
    const t = this.anchor(when);
    s.peak = peak;
    if (inAttack) {
      this.setTarget(peak, t, phaseTau(s.attack));
      this.setTarget(peak * s.sustain, s.attackEnd, phaseTau(s.decay));
      return;
    }
    // A running decay keeps its own time constant: re-aiming a memoryless segment
    // from where it is, on the same constant, retraces the decay exactly.
    const decaying = t < s.attackEnd + s.decay;
    const glide = decaying ? phaseTau(s.decay) : Math.max(tau, phaseTau(MIN_PHASE_SECONDS));
    this.setTarget(peak * s.sustain, t, glide);
  }

  /** Trigger release phase. */
  release_(when: number): void {
    this.struck = null;
    const t = this.anchor(when);
    this.setTarget(0, t, phaseTau(this.release));
  }

  /** Fast cut to silence (voice stealing) — the external-cut entry point. */
  cutFast(when: number, tau = 0.003): void {
    this.struck = null;
    const t = this.anchor(when);
    this.setTarget(0, t, tau);
  }

  /** Approximate time at which release will be effectively silent. */
  releaseDuration(): number {
    // Five knob times, and a knob time is PHASE_TIME_CONSTANTS (3) time
    // constants, so 15 τ: ~-130 dB, effectively zero.
    return this.release * 5;
  }

  /**
   * Cancel from `t` and pin the value the curve reaches at `t` (REQ-envelope-scheduling-is-future-time-safe).
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
      if (seg) v = approach(v, seg.target, e.time - at, seg.tau);
      at = e.time;
      if (e.value !== undefined) { v = e.value; seg = null; }
      else { seg = { target: e.target!, tau: e.tau! }; }
    }
    if (seg && t > at) v = approach(v, seg.target, t - at, seg.tau);
    return v;
  }
}
