import type { ParamBus } from '../state/params';
import { syncedValue, type TempoQuantity } from '../utils/tempo';

/**
 * Wire a rate/time param to its tempo lock — tempo-lock.md REQ-7.
 *
 * `apply` receives whichever value is currently in charge: the division `syncId`
 * names, resolved against the live tempo, or — while `syncId` is `free` (0) — the
 * knob's own `valueId`. The knob value is **never rewritten**, so unlocking
 * restores the exact previous sound (lfo.md REQ-9, tempo-lock.md REQ-4).
 *
 * One definition of "synced", shared by the LFOs and the wah/phaser/delay, so the
 * two cannot drift into two different answers. It deliberately owns only *which*
 * value is applied — `apply` is the effect's existing setter, so each keeps its
 * own smoothing (`RAMP_SMOOTH` for the FX, effects.md REQ-2b; `RAMP_MEDIUM` for
 * the LFO). This feature changes what is applied, never how.
 *
 * The house self-wiring pattern (ADR-008): called from an `Effect.bind(bus, prefix)`,
 * not from `Engine.subscribeParams()`.
 */
export function bindTempoLocked(
  bus: ParamBus,
  valueId: string,
  syncId: string,
  quantity: TempoQuantity,
  apply: (v: number) => void,
): void {
  const applyNow = (): void => {
    apply(syncedValue(bus.get(syncId), bus.get('transport.bpm'), quantity) ?? bus.get(valueId));
  };

  bus.subscribe(valueId, applyNow);
  bus.subscribe(syncId, applyNow);
  // A locked effect tracks the tempo, including a slave's incoming MIDI clock
  // (midi-clock-sync.md). A no-op while the lock is free. Subscribed last so the
  // immediate fire on the two above cannot read a half-built closure.
  bus.subscribe('transport.bpm', applyNow);
}
