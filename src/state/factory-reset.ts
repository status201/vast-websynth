import { SampleAutosave } from './sample-autosave';
import { requestOfflineRedownload } from './offline-redownload';
import {
  OFFLINE_CACHE_PREFIX,
  browserCacheDeps,
  deleteOfflineCopies,
  type OfflineFetch,
} from '../utils/offline-copy';
import { withTimeout } from '../utils/async';

/**
 * Restore to Factory Settings — wipe every piece of device-local state and
 * reload into the boot-time defaults (specs/features/factory-reset.md).
 *
 * The reload is mandatory: clearing storage does not reset live in-memory
 * state (ParamBus values, pattern banks, the preset index read at boot), and
 * perf-mode's audio knobs are boot-time-only. `reload` is injectable so the
 * helper is testable under jsdom, where `location.reload` is unimplemented.
 *
 * Sampler clips live in IndexedDB (sample-persistence.md), and the service
 * worker's caches in CacheStorage (REQ-8) — both async, so both are awaited but
 * capped: neither a wedged IndexedDB nor a wedged Cache API can hold the reload
 * hostage.
 */

/** How long the async clip-store wipe may delay the reload (REQ-7). */
const CLIP_CLEAR_TIMEOUT_MS = 500;

/** How long "is the server there?" may take before the caches are kept (REQ-9). */
const REACHABLE_TIMEOUT_MS = 3000;

/** The whole offline-copy step's cap, probe included (REQ-9). */
const CACHE_STEP_TIMEOUT_MS = 4000;

/** The browser's by default; tests inject both. */
export interface FactoryResetDeps {
  caches?: CacheStorage;
  fetch?: OfflineFetch;
}

export async function restoreFactorySettings(
  reload: () => void = () => location.reload(),
  deps: FactoryResetDeps = {},
): Promise<void> {
  // Started first — it only reads and deletes caches, never storage — so it runs
  // alongside the storage clears rather than after them.
  const cacheStep = withTimeout(clearOfflineCopy(deps), CACHE_STEP_TIMEOUT_MS, { redownload: false });

  try { localStorage.clear(); } catch { /* storage may be unavailable */ }
  try { sessionStorage.clear(); } catch { /* storage may be unavailable */ }

  // SampleAutosave.clear never rejects; the cap only guards a hang.
  const [{ redownload }] = await Promise.all([
    cacheStep,
    withTimeout(SampleAutosave.clear(), CLIP_CLEAR_TIMEOUT_MS, undefined),
  ]);
  // After the clear, so this one intent survives the reload and nothing else does.
  if (redownload) requestOfflineRedownload();
  reload();
}

/**
 * Delete the app's caches when that is safe, and say whether the offline copy
 * should come back (REQ-8/REQ-9). With nothing cached there is nothing to probe.
 */
async function clearOfflineCopy(deps: FactoryResetDeps): Promise<{ redownload: boolean }> {
  const browser = browserCacheDeps();
  const cacheStorage = deps.caches ?? browser.caches;
  const fetchFn = deps.fetch ?? browser.fetch;
  if (!cacheStorage || !fetchFn) return { redownload: false };

  const names = await cacheStorage.keys();
  if (!names.some((n) => n.startsWith(OFFLINE_CACHE_PREFIX))) return { redownload: false };
  // Offline, the reload itself would need these files — delete nothing.
  if (!(await serverReachable(fetchFn))) return { redownload: false };

  const { hadCopy } = await deleteOfflineCopies(cacheStorage);
  return { redownload: hadCopy };
}

/** Any HTTP answer to `HEAD /` counts. A non-GET, so the worker passes it to the network. */
async function serverReachable(fetchFn: OfflineFetch): Promise<boolean> {
  try {
    await fetchFn('/', { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}
