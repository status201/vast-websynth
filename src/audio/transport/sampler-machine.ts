import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { SAMPLER_SLOT_COUNT } from '../../state/patterns';
import { chokeAt, forEachActiveHit } from './step-hits';
import { clamp01 } from '../../utils/math';
import type { TickSubscriber } from './tick-source';
import { ListenerSet } from '../../utils/listeners';
import { LaneMeter } from './lane-meter';

export type SamplerStepListener = (step: number) => void;

/** Click-free cut: ramp the per-hit gain to 0 over CHOKE_FADE, stop just after. */
const CHOKE_FADE = 0.005;
/**
 * Attack ramp on a slot's per-hit gain (sampler.md REQ-11).
 *
 * User audio is exactly the material we cannot assume anything about: a sample
 * whose first frame is not near zero used to start on a full-scale step, which is
 * a click on every hit. 0.5 ms is ~24 samples at 48 kHz — Web Audio ramps are
 * sample-accurate, so this is not rounded up to a render block. Enough to turn a
 * step into a slope, far too short to soften a transient: a chop's own attack is
 * orders of magnitude longer.
 */
const SAMPLER_ATTACK = 0.0005;

const CHOKE_STOP = 0.03;

/**
 * Multi-track sampler — structurally a sibling of the DrumMachine, but each
 * of the SAMPLER_SLOT_COUNT slots plays a user-loaded AudioBuffer one-shot
 * instead of a synthesized voice. Reads the sampler bank the Arrangement
 * selects each tick. Decoded buffers live here (not in PatternStore).
 */
export class SamplerMachine {
  readonly slotGains: GainNode[] = [];
  readonly buffers: (AudioBuffer | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);
  readonly muted: boolean[] = Array(SAMPLER_SLOT_COUNT).fill(false);

  private enabled = false;
  private readonly stepListeners = new ListenerSet<[number]>();
  private readonly bufferListeners = new ListenerSet<[number]>();
  /** Hits still sounding (or still scheduled), so a transport stop can cut them
   *  (REQ-8). Drums self-terminate; a user sample is any length at all. */
  private readonly inFlight = new Set<{ src: AudioBufferSourceNode; g: GainNode }>();
  /** This machine's loop length + step rate (meter.md REQ-10/REQ-14). */
  readonly lane: LaneMeter;

  constructor(
    private readonly ctx: AudioContext,
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
    private readonly samplerBus: GainNode,
  ) {
    this.lane = new LaneMeter(clock, (s) => perf.mapStep(s));
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
      const g = this.ctx.createGain();
      g.gain.value = 1;
      g.connect(this.samplerBus);
      this.slotGains.push(g);
    }

    clock.onTick((step, when) => this.onTick(step, when));
  }

  setEnabled(on: boolean): void { this.enabled = on; }

  onStep(fn: SamplerStepListener): () => void {
    return this.stepListeners.add(fn);
  }

  /**
   * A slot's buffer was replaced or cleared. The single hook every slot-filling
   * path funnels through (Load, the record modal, ✎ re-edit, render-to-sampler,
   * project-zip import, load-undo, New) — `SampleAutosave` persists off it
   * without any caller knowing (sample-persistence.md REQ-2).
   */
  onBufferChange(fn: (slot: number) => void): () => void {
    return this.bufferListeners.add(fn);
  }

  setSlotMute(slot: number, muted: boolean): void {
    if (slot >= 0 && slot < SAMPLER_SLOT_COUNT) this.muted[slot] = muted;
  }

  setBuffer(slot: number, buf: AudioBuffer | null): void {
    if (slot < 0 || slot >= SAMPLER_SLOT_COUNT) return;
    this.buffers[slot] = buf;
    this.bufferListeners.emit(slot);
  }

  /** Manual trigger (for UI auditioning). */
  triggerSlot(slot: number, velocity = 0.9): void {
    this.play(slot, this.ctx.currentTime, velocity);
  }

  private play(slot: number, when: number, velocity: number, chokeAt?: number): void {
    const buf = this.buffers[slot];
    const out = this.slotGains[slot];
    if (!buf || !out) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    const vel = clamp01(velocity);
    // `when` can be in the past (step-settings.md REQ-9); the choke shifts by the
    // same delta as the start so a short gate keeps its LENGTH instead of
    // collapsing — or resolving to 0 and dropping the hit (sampler.md REQ-11).
    const t = Math.max(when, this.ctx.currentTime);
    const shift = t - when;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + SAMPLER_ATTACK);
    src.connect(g).connect(out);
    src.start(t);
    if (chokeAt !== undefined) {
      // Step gate < 1 chokes the sample early with a fast fade.
      const cut = Math.max(chokeAt + shift, t + SAMPLER_ATTACK);
      g.gain.setValueAtTime(vel, cut);
      g.gain.linearRampToValueAtTime(0, cut + CHOKE_FADE);
      src.stop(cut + CHOKE_STOP);
    }
    const hit = { src, g };
    this.inFlight.add(hit);
    src.onended = () => { this.inFlight.delete(hit); src.disconnect(); g.disconnect(); };
  }

  /**
   * Cut every hit still sounding, with the same short fade the gate choke uses so
   * the cut never clicks (REQ-8). The fade is on the per-hit gain, upstream of
   * `samplerBus`, so the FX tails ring out untouched — Stop silences the source,
   * not the room. A hit still scheduled inside the look-ahead simply never plays.
   *
   * Public because *when* to cut is the Engine's call, not the machine's: a stop
   * that ends a capture is deliberately rendering the tail and must not chop the
   * last bar's one-shots out of it.
   */
  stopAll(): void {
    const now = this.ctx.currentTime;
    for (const { src, g } of this.inFlight) {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + CHOKE_FADE);
      src.stop(now + CHOKE_STOP);
    }
    // `onended` empties the set as each source actually stops.
  }

  private onTick(step: number, when: number): void {
    if (!this.enabled) return;
    this.lane.forEachHit(step, when, (idx, at, cellDur) => {
      this.stepListeners.emit(idx);

      // Arrangement rest bar: keep the playhead moving but trigger nothing.
      if (this.arrangement.samplerResting) return;

      // Sampler plays through drum fills (no fill behaviour of its own).
      const bank = this.patterns.samplerBank(this.arrangement.samplerPlayBank);
      forEachActiveHit(bank, idx, at, cellDur, this.muted, (s, h, cell) => {
        this.play(s, h.t, cell.velocity, chokeAt(cell, h));
      });
    });
  }
}
