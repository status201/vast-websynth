import { WrappedEffect, bindBypassMix } from './effect';
import { clamp01 } from '../../utils/math';
import { RAMP_SMOOTH } from '../param-utils';
import type { ParamBus } from '../../state/params';

/** `<prefix>.src` index that keys off every drum track (sidechain-ducking.md REQ-7). */
export const DUCK_SRC_ANY = 8;

/**
 * The envelope's value at time `t`, computed analytically.
 *
 * Exists because `cancelAndHoldAtTime` — which would give us the same number for
 * free — is not implemented in Firefox. A retrigger must know where the envelope
 * currently is so it can pin that value before ramping again; cancelling without
 * pinning lets the param snap back to the cancelled ramp's start.
 *
 * Scalar arguments rather than a state object so a per-hit call allocates
 * nothing. `onset` of `-Infinity` (no hit yet) falls through to `exp(-Infinity)`
 * = 0, i.e. no duck.
 */
export function envValueAt(
  t: number,
  onset: number,
  startVal: number,
  attack: number,
  release: number,
): number {
  if (t < onset) return startVal;
  if (t < onset + attack) return startVal + (1 - startVal) * ((t - onset) / attack);
  return Math.exp(-(t - onset - attack) / release);
}

/**
 * Trigger-keyed sidechain ducking (sidechain-ducking.md).
 *
 * `duckGain.gain` holds an intrinsic 1 and sums a `-amount`-scaled envelope
 * coming in from `env`, so the gain law is `1 - amount * e(t)` with both factors
 * in [0,1] — bounded by construction, no clamp and no feedback path (REQ-2).
 * There is no DSP on the audio thread at all: the envelope is native
 * `AudioParam` automation, scheduled at the absolute time the drum machine has
 * already decided a hit will sound (REQ-1).
 *
 * No `setMix` — the ducker has no dry/wet, so `bindBypassMix` subscribes only
 * `.on`, the same way the wah and the compressors opt out (effects.md REQ-1).
 */
export class Ducker extends WrappedEffect {
  private readonly duckGain: GainNode;
  private readonly depthGain: GainNode;
  private readonly env: ConstantSourceNode;

  private src = 0;
  private attack = 0.005;
  private release = 0.18;
  /** Time of the last scheduled onset, and the envelope value pinned there. */
  private onset = -Infinity;
  private startVal = 0;
  private bypassed = true;

  constructor(ctx: AudioContext) {
    super(ctx, 1);

    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1; // the intrinsic term of `1 - amount * e(t)`

    this.depthGain = ctx.createGain();
    this.depthGain.gain.value = 0; // no-op until `.amount` binds

    this.env = ctx.createConstantSource();
    this.env.offset.value = 0; // 0 = no duck, which is also the resting value

    // env → depthGain → duckGain.gain (an AudioParam input, summed with the
    // intrinsic 1). Started once and never stopped, like the wah's LFO: while
    // the effect is bypassed ADR-012 disconnects the wrapper's edges, so the
    // whole subgraph is unreachable from the destination and costs nothing.
    this.env.connect(this.depthGain).connect(this.duckGain.gain);
    this.env.start();

    this.wrap.processedIn.connect(this.duckGain).connect(this.wrap.processedOut);
  }

  override setBypass(b: boolean): void {
    super.setBypass(b);
    this.bypassed = b;
  }

  setAmount(a: number): void {
    // Negative: the envelope *subtracts* from the intrinsic 1 (REQ-2).
    this.depthGain.gain.setTargetAtTime(-clamp01(a), this.ctx.currentTime, RAMP_SMOOTH);
  }
  setAttack(s: number): void {
    this.attack = Math.max(0.001, s);
  }
  setRelease(s: number): void {
    this.release = Math.max(0.001, s);
  }
  setSrc(i: number): void {
    this.src = Math.round(i);
  }

  /**
   * A drum hit sounded on `track` at absolute time `when` (REQ-1). Schedules the
   * duck if this track is the key, otherwise ignores it.
   */
  onDrumHit(track: number, when: number): void {
    // A bypassed ducker is inaudible, so scheduling would be pure main-thread
    // waste — the same early-out shape as the mod matrix's random source (REQ-6).
    if (this.bypassed) return;
    if (this.src !== DUCK_SRC_ANY && track !== this.src) return;
    // `forEachActiveHit` sweeps lanes outer, ratchets inner, so with `Any` a
    // later ratchet sub-hit can be emitted before an earlier lane's hit.
    // Cancelling for the earlier time would erase the ramp already scheduled for
    // the later one and strand the envelope mid-duck (REQ-4). Both fall inside
    // one 16th, so nothing audible is lost by skipping it.
    if (when < this.onset) return;

    const p = this.env.offset;
    const start = envValueAt(when, this.onset, this.startVal, this.attack, this.release);
    p.cancelScheduledValues(when);
    p.setValueAtTime(start, when);
    p.linearRampToValueAtTime(1, when + this.attack);
    // Always the last event scheduled: the envelope's terminal state is a decay
    // to *no duck*, which is why a stop, a dropout or a bypass all recover with
    // no explicit release path (REQ-5).
    p.setTargetAtTime(0, when + this.attack, this.release);

    this.onset = when;
    this.startVal = start;
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this); // no setMix — the ducker has no dry/wet
    bus.subscribe(`${prefix}.amount`, (x) => this.setAmount(x));
    bus.subscribe(`${prefix}.attack`, (x) => this.setAttack(x));
    bus.subscribe(`${prefix}.release`, (x) => this.setRelease(x));
    bus.subscribe(`${prefix}.src`, (x) => this.setSrc(x));
  }
}
