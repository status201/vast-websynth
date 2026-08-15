import type { TempoQuantity } from '../utils/tempo';

/**
 * Which faceplate params can be locked to the song's grid — tempo-lock.md REQ-1.
 *
 * This is the *whole* declaration. A `Knob` looks its own param up here and builds
 * the lock only on a hit, exactly as it already does for modulation via
 * `modDepthDeps` (ADR-008, components self-wire their params). So `fxPanel`,
 * `fxGroup`, the LFO panel and the Live FX window all gain the lock without a
 * signature growing anywhere — and a param cannot end up lockable on one surface
 * and free on another, because there is only one list to read.
 *
 * Lives in `state/` beside `mod-depth.ts` for the same reason: it names param ids,
 * so the UI can consult it without reaching into `audio/`.
 *
 * The value is the **knob's** unit, not the division's: a delay knob is registered
 * in seconds, every other lockable one in Hz.
 */
export const TEMPO_LOCKS: Record<string, TempoQuantity> = {
  'lfo.rate': 'freq',
  'lfo2.rate': 'freq',
  'fx.wah.rate': 'freq',
  'fx.phaser.rate': 'freq',
  'fx.drum.phaser.rate': 'freq',
  'fx.sampler.phaser.rate': 'freq',
  'fx.delay.time': 'time',
  'fx.drum.delay.time': 'time',
  'fx.sampler.delay.time': 'time',
};

/** The quantity `paramId` locks in, or `undefined` when it is not lockable. */
export function tempoLockFor(paramId: string): TempoQuantity | undefined {
  return TEMPO_LOCKS[paramId];
}

/**
 * The discrete sync param a lockable param pairs with: `fx.delay.time` →
 * `fx.delay.sync`, `lfo.rate` → `lfo.sync`.
 *
 * Derived rather than stored as a second column, so the pair cannot drift — every
 * lockable id ends in the one segment that gets replaced.
 */
export function syncIdFor(paramId: string): string {
  return paramId.replace(/\.[^.]+$/, '.sync');
}
