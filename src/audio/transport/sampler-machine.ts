import type { Engine } from '../engine';
import type { Clock } from './clock';
import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { SAMPLER_SLOT_COUNT, SEQ_LENGTH } from '../../state/patterns';

export type SamplerStepListener = (step: number) => void;

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
  private readonly stepListeners = new Set<SamplerStepListener>();

  constructor(
    private readonly engine: Engine,
    clock: Clock,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
  ) {
    const ctx = engine.ctx;
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(engine.samplerBus);
      this.slotGains.push(g);
    }

    clock.onTick((step, when) => this.onTick(step, when));
  }

  setEnabled(on: boolean): void { this.enabled = on; }

  onStep(fn: SamplerStepListener): () => void {
    this.stepListeners.add(fn);
    return () => { this.stepListeners.delete(fn); };
  }

  setSlotMute(slot: number, muted: boolean): void {
    if (slot >= 0 && slot < SAMPLER_SLOT_COUNT) this.muted[slot] = muted;
  }

  setBuffer(slot: number, buf: AudioBuffer | null): void {
    if (slot >= 0 && slot < SAMPLER_SLOT_COUNT) this.buffers[slot] = buf;
  }

  /** Manual trigger (for UI auditioning). */
  triggerSlot(slot: number, velocity = 0.9): void {
    this.play(slot, this.engine.ctx.currentTime, velocity);
  }

  private play(slot: number, when: number, velocity: number): void {
    const buf = this.buffers[slot];
    const out = this.slotGains[slot];
    if (!buf || !out) return;
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1, velocity));
    src.connect(g).connect(out);
    src.start(Math.max(when, ctx.currentTime));
    src.onended = () => { src.disconnect(); g.disconnect(); };
  }

  private onTick(step: number, when: number): void {
    if (!this.enabled) return;
    const idx = this.perf.mapStep(step) % SEQ_LENGTH;
    for (const l of this.stepListeners) l(idx);

    // Sampler plays through drum fills (no fill behaviour of its own).
    const bank = this.patterns.samplerBank(this.arrangement.samplerPlayBank);
    for (let s = 0; s < SAMPLER_SLOT_COUNT; s++) {
      if (this.muted[s]) continue;
      const cell = bank[s]?.[idx];
      if (cell && cell.on) this.play(s, when, cell.velocity);
    }
  }
}
