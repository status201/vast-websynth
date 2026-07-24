import { SampleAutosave } from './sample-autosave';

/**
 * Restore to Factory Settings — wipe every piece of device-local state and
 * reload into the boot-time defaults (specs/features/factory-reset.md).
 *
 * The reload is mandatory: clearing storage does not reset live in-memory
 * state (ParamBus values, pattern banks, the preset index read at boot), and
 * perf-mode's audio knobs are boot-time-only. `reload` is injectable so the
 * helper is testable under jsdom, where `location.reload` is unimplemented.
 *
 * Sampler clips live in IndexedDB (sample-persistence.md), which is async and
 * unlike localStorage cannot be cleared synchronously — the wipe is awaited but
 * capped, so a wedged IndexedDB can never hold the reload hostage.
 */

/** How long the async clip-store wipe may delay the reload. */
const CLIP_CLEAR_TIMEOUT_MS = 500;

export async function restoreFactorySettings(reload: () => void = () => location.reload()): Promise<void> {
  try { localStorage.clear(); } catch { /* storage may be unavailable */ }
  try { sessionStorage.clear(); } catch { /* storage may be unavailable */ }
  // SampleAutosave.clear never rejects; the race only guards a hang. The timer
  // is cleared either way so it can't outlive the (usually instant) wipe.
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    SampleAutosave.clear(),
    new Promise<void>((r) => { cap = setTimeout(r, CLIP_CLEAR_TIMEOUT_MS); }),
  ]);
  if (cap !== undefined) clearTimeout(cap);
  reload();
}
