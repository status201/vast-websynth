// The Debug panel's late-bound row sources (debug-panel.md REQ-the-debug-extension-contract/REQ-an-unbound-row-reads-n-a).
//
// These live outside the About modal on purpose. `main.ts` binds them at boot,
// and the modal itself is behind a dynamic import — so if the setters shipped
// with the panel, that one static edge from `main.ts` would drag all ~39 kB of
// modal back into the entry chunk and undo the split
// (runtime-performance.md REQ-boot-cost-matches-the-request). A leaf module with no imports of its own is
// the cheapest thing a boot-path binder can reach.
//
// The idiom is app.ts's live scope knobs: the owner of the state binds a reader,
// and an unbound reader is `undefined`, which the panel renders as "n/a" — the
// honest answer in a build where that subsystem never started.
//
// `ScopeHealth` is imported TYPE-ONLY, so this leaf still emits no import at
// runtime and the boot path stays free of the UI layer.

import type { ScopeHealth } from '../ui/components/scope';

/**
 * Bound by `main.ts` to the `SampleAutosave` it owns (sample-persistence.md
 * REQ-debug-shows-the-clip-store-size). Unbound in a build where clip persistence never started.
 */
let clipSource: (() => { count: number; bytes: number }) | null = null;
export function setClipStatsSource(fn: () => { count: number; bytes: number }): void {
  clipSource = fn;
}
export function clipStats(): { count: number; bytes: number } | undefined {
  return clipSource?.();
}

/** Bound by `main.ts` once `initMIDI` resolves an access handle (the audio layer
 *  must not import UI). Unbound before the start gesture, because there is
 *  deliberately no MIDI permission prompt until then. */
let midiSource: (() => { inputs: number; outputs: number }) | null = null;
export function setMidiStatsSource(fn: () => { inputs: number; outputs: number }): void {
  midiSource = fn;
}
export function midiStats(): { inputs: number; outputs: number } | undefined {
  return midiSource?.();
}

/**
 * Bound by `app.ts`, which owns the `Scope` (scope.md REQ-the-panel-says-whether-it-is-drawing). The one row that
 * answers "is the panel actually painting?" — this symptom has been reported twice
 * from devices with no console, and both times there was nothing to read.
 */
let scopeSource: (() => ScopeHealth) | null = null;
export function setScopeStatsSource(fn: () => ScopeHealth): void {
  scopeSource = fn;
}
export function scopeStats(): ScopeHealth | undefined {
  return scopeSource?.();
}

/** Bound by `main.ts`, which owns the wake-lock manager. */
let wakeSource: (() => { supported: boolean; held: boolean }) | null = null;
export function setWakeLockSource(fn: () => { supported: boolean; held: boolean }): void {
  wakeSource = fn;
}
export function wakeState(): { supported: boolean; held: boolean } | undefined {
  return wakeSource?.();
}
