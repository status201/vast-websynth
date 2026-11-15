/**
 * Which version the server serves now, and which version a service worker was
 * registered for (specs/features/version-skew.md). A tab that outlived a deploy
 * asks this once something fails to load, to tell "a newer release replaced the
 * file" apart from "the download failed".
 *
 * A leaf (its one import, `limits.ts`, is constants only): the eager lazy-load
 * toast reaches it, so it must not drag the offline-copy state machine (which
 * re-exports the manifest URL from here) into the entry chunk.
 */
import { MAX_VERSION_CHARS } from '../state/limits';

/** Where the build writes the file list (scripts/lib/offline-manifest.mjs) — its `version` is the probe's answer. */
export const OFFLINE_MANIFEST_URL = '/offline-manifest.json';

/**
 * How long the probe may take before it counts as "unknown"
 * (version-skew.md REQ-the-version-probe-is-bounded). A failure report waits on it, so a hanging
 * request on a captive portal must not hold the report back.
 */
export const VERSION_PROBE_TIMEOUT_MS = 3000;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// Wrapped: a detached `window.fetch` can throw "Illegal invocation".
const defaultFetch: FetchFn = (input, init) => fetch(input, init);

/** The `?v=` a worker was registered with (`/sw.js?v=<version>`). */
export function workerVersion(worker: ServiceWorker | null | undefined): string | null {
  if (!worker) return null;
  try {
    return new URL(worker.scriptURL).searchParams.get('v');
  } catch {
    return null;
  }
}

/**
 * Is `live` a later release than `ours`? Dotted numbers compare numerically
 * (`2.10.0` > `2.9.1`), so a rollback is not "newer"; a version in any other
 * shape compares by inequality alone, because nothing better can be said of it.
 */
export function isNewerVersion(live: string, ours: string): boolean {
  const parse = (v: string): number[] | null => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const a = parse(live);
  const b = parse(ours);
  if (!a || !b) return live !== ours;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * The version the server serves now, or `null` when that cannot be told — and
 * never a rejection (version-skew.md REQ-the-version-probe-is-bounded). `no-store`, because the
 * whole point is to see past every cache; aborted after `timeoutMs`.
 */
export async function liveVersion(
  fetchFn: FetchFn = defaultFetch,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchFn(OFFLINE_MANIFEST_URL, { cache: 'no-store', signal: abort.signal });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null) return null;
    const v = (raw as { version?: unknown }).version;
    return typeof v === 'string' && v.length > 0 && v.length <= MAX_VERSION_CHARS ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True only when the server's version is known and later than ours (version-skew.md REQ-a-failure-asks-whether-a-newer-version-is-live). */
export async function newerVersionLive(fetchFn: FetchFn = defaultFetch, ours: string = __APP_VERSION__): Promise<boolean> {
  const live = await liveVersion(fetchFn);
  return live !== null && isNewerVersion(live, ours);
}

/**
 * Call `onTakeover` — at most once — when this tab's controller becomes a
 * worker registered for any other version: its `activate` has just purged this
 * version's cache, whichever way the versions differ. Whether that is worth
 * telling the user is the caller's call (version-skew.md REQ-a-takeover-by-a-newer-worker-is-announced,
 * play-offline.md REQ-offline-cancel-and-takeover). Returns the unsubscribe.
 */
export function watchForTakeover(
  sw: ServiceWorkerContainer,
  onTakeover: (version: string) => void,
  ours: string = __APP_VERSION__,
): () => void {
  const onChange = (): void => {
    const v = workerVersion(sw.controller);
    if (v === null || v === ours) return;
    sw.removeEventListener('controllerchange', onChange);
    onTakeover(v);
  };
  sw.addEventListener('controllerchange', onChange);
  return () => sw.removeEventListener('controllerchange', onChange);
}
