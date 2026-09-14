/**
 * The page side of **Play offline** — saves every file the build lists into the
 * service worker's cache, with progress (specs/features/play-offline.md).
 *
 * The worker (`public/sw.js`, pwa-install.md REQ-6) caches only what a visit
 * fetched, and the build is many files: demo songs fetched on click, dialogs
 * behind `import()`. This class walks `offline-manifest.json` (written by the
 * build, play-offline.md REQ-2) and fills `websynth-<version>` with all of it,
 * then leaves a marker the worker's `install` reads to keep the copy whole across
 * releases (REQ-7).
 *
 * The download runs here rather than in the worker on purpose: a page has no
 * event-lifetime cap, can report progress synchronously and can abort its own
 * fetches. The worker's release refresh is the one part only a worker can do.
 *
 * No UI: `about-offline.ts` renders `state`, `offline-notices.ts` announces it.
 * Browser surfaces are injected, so the whole state machine is testable without
 * a DOM (the wake-lock precedent).
 */
import { ListenerSet } from './listeners';
import { delay } from './async';

// ---- the contract shared with sw.js (REQ-10) ----

/** The marker's cache key. Mirrored by `OFFLINE_MARKER` in sw.js. */
export const OFFLINE_MARKER_URL = '/__offline-copy';

/** Where the build writes the file list (scripts/lib/offline-manifest.mjs). */
export const OFFLINE_MANIFEST_URL = '/offline-manifest.json';

/** Every cache the worker names starts with this. Mirrors `CACHE_PREFIX` in sw.js. */
export const OFFLINE_CACHE_PREFIX = 'websynth-';

/** The worker's cache for a version. Mirrors `cacheName` in sw.js. */
export const offlineCacheName = (version: string): string => `${OFFLINE_CACHE_PREFIX}${version}`;

/**
 * Every lookup ignores `Vary` (REQ-11). A host's `Vary: Origin` makes the cache
 * compare request headers, and a URL-only lookup here carries none of the ones a
 * worker-cached script request did — so a file on the device would read as
 * missing. The app's files never differ by request header.
 */
const MATCH: CacheQueryOptions = { ignoreVary: true };

// ---- shapes ----

export interface OfflineFile {
  url: string;
  bytes: number;
}

export interface OfflineManifest {
  version: string;
  files: OfflineFile[];
  totalBytes: number;
}

/** What a finished download writes, and what "complete" is judged by. */
interface OfflineMarker {
  version: string;
  files: string[];
  totalBytes: number;
  completedAt: string;
}

export type OfflineErrorReason = 'files' | 'offline' | 'storage' | 'worker';

export type OfflineState =
  | { kind: 'unsupported'; reason: 'dev' | 'browser' }
  | { kind: 'checking' }
  | { kind: 'none'; totalBytes: number | null; remainingBytes: number | null }
  /** `totalFiles === 0` means the list is not known yet (preparing). */
  | { kind: 'downloading'; doneFiles: number; totalFiles: number; doneBytes: number; totalBytes: number }
  | { kind: 'complete'; files: number; totalBytes: number; persisted: boolean }
  | { kind: 'error'; reason: OfflineErrorReason; failed: number }
  | { kind: 'needs-reload' };

export type OfflineFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface OfflineCopyDeps {
  /** False on the dev server — the worker is production-only (pwa-install.md REQ-6). */
  enabled: boolean;
  version: string;
  caches?: CacheStorage;
  /** Must be callable detached — pass a wrapper, never a bare `window.fetch`. */
  fetch?: OfflineFetch;
  serviceWorker?: ServiceWorkerContainer;
  storage?: StorageManager;
  /** How long to wait for this version's worker when none is on the way. */
  readyTimeoutMs?: number;
  pollMs?: number;
  concurrency?: number;
}

/** The page's CacheStorage and a detached-safe `fetch`, each undefined where absent. */
export function browserCacheDeps(): { caches?: CacheStorage; fetch?: OfflineFetch } {
  return {
    caches: typeof caches === 'undefined' ? undefined : caches,
    // Wrapped: a detached `window.fetch` throws "Illegal invocation".
    fetch: typeof fetch === 'undefined' ? undefined : (input, init) => fetch(input, init),
  };
}

// ---- the manifest and the marker ----

const PROBE_ORIGIN = 'https://offline-copy.invalid';

/** Root-relative and same-origin once resolved — `//x` and `/\x` both escape. */
function isSameOriginPath(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith('/')) return false;
  try {
    return new URL(url, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

const sumBytes = (files: readonly OfflineFile[]): number => files.reduce((sum, f) => sum + f.bytes, 0);

/**
 * Validate the manifest's shape (REQ-9). It is our own build output, so this is
 * not a byte budget — it only guarantees no entry can point a fetch elsewhere and
 * that the list belongs to this version. `totalBytes` is recomputed, not trusted.
 */
export function parseOfflineManifest(raw: unknown, version: string): OfflineManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { version: v, files: list } = raw as { version?: unknown; files?: unknown };
  if (v !== version || !Array.isArray(list)) return null;
  const files: OfflineFile[] = [];
  for (const entry of list as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { url, bytes } = entry as { url?: unknown; bytes?: unknown };
    if (!isSameOriginPath(url)) return null;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
    files.push({ url, bytes });
  }
  return { version, files, totalBytes: sumBytes(files) };
}

async function readMarker(cache: Cache, version: string): Promise<OfflineMarker | null> {
  try {
    const res = await cache.match(OFFLINE_MARKER_URL, MATCH);
    if (!res) return null;
    const m = (await res.json()) as Partial<OfflineMarker>;
    if (m.version !== version || typeof m.totalBytes !== 'number' || !Array.isArray(m.files)) return null;
    if (!m.files.every((u) => typeof u === 'string')) return null;
    return m as OfflineMarker;
  } catch {
    return null;
  }
}

function markerResponse(manifest: OfflineManifest): Response {
  const marker: OfflineMarker = {
    version: manifest.version,
    files: manifest.files.map((f) => f.url),
    totalBytes: manifest.totalBytes,
    completedAt: new Date().toISOString(),
  };
  return new Response(JSON.stringify(marker), { headers: { 'Content-Type': 'application/json' } });
}

async function missingFiles(cache: Cache, files: readonly OfflineFile[]): Promise<OfflineFile[]> {
  const hits = await Promise.all(files.map((f) => cache.match(f.url, MATCH)));
  return files.filter((_, i) => !hits[i]);
}

/**
 * Delete every app cache — the saved offline copy and the worker's runtime cache
 * alike — and report whether any held a complete copy. Foreign caches on the
 * origin are left alone. Factory reset's half of REQ-12 (factory-reset.md REQ-8).
 */
export async function deleteOfflineCopies(cacheStorage: CacheStorage): Promise<{ hadCopy: boolean }> {
  const names = (await cacheStorage.keys()).filter((n) => n.startsWith(OFFLINE_CACHE_PREFIX));
  const markers = await Promise.all(
    names.map(async (n) => (await cacheStorage.open(n)).match(OFFLINE_MARKER_URL, MATCH)),
  );
  await Promise.all(names.map((n) => cacheStorage.delete(n)));
  return { hadCopy: markers.some(Boolean) };
}

/** The `?v=` a worker was registered with (`/sw.js?v=<version>`). */
function workerVersion(worker: ServiceWorker | null | undefined): string | null {
  if (!worker) return null;
  try {
    return new URL(worker.scriptURL).searchParams.get('v');
  } catch {
    return null;
  }
}

const isQuotaError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'QuotaExceededError';

// ---- the state machine ----

/** What `prepare` hands the download once the worker, the list and the space check pass. */
interface Plan {
  cache: Cache;
  manifest: OfflineManifest;
  missing: OfflineFile[];
}

export class OfflineCopy {
  private readonly deps: OfflineCopyDeps;
  private current: OfflineState = { kind: 'checking' };
  private readonly listeners = new ListenerSet<[OfflineState]>();
  private job: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private stopReason: 'cancel' | 'takeover' | null = null;

  constructor(deps: OfflineCopyDeps) {
    this.deps = deps;
  }

  get state(): OfflineState {
    return this.current;
  }

  /** Called on every change; not called with the current state. */
  subscribe(fn: (s: OfflineState) => void): () => void {
    return this.listeners.add(fn);
  }

  /** Re-read what this device holds (REQ-4). A no-op while downloading. */
  async refresh(): Promise<void> {
    if (this.job) return;
    const unsupported = this.unsupportedReason();
    if (unsupported) {
      this.set({ kind: 'unsupported', reason: unsupported });
      return;
    }
    const next = await this.inspect();
    // A start() that began while we were reading owns the state now.
    if (!this.job) this.set(next);
  }

  /** Download everything (REQ-5). A second call while running joins the first. */
  start(): Promise<void> {
    if (this.job) return this.job;
    const unsupported = this.unsupportedReason();
    if (unsupported) {
      this.set({ kind: 'unsupported', reason: unsupported });
      return Promise.resolve();
    }
    // Inside the click, before any await: Firefox answers persist() with a
    // permission prompt tied to the gesture, and the download must never wait
    // for the user to answer it. A refusal only means the browser may evict.
    try {
      void this.deps.storage?.persist?.().catch(() => false);
    } catch {
      /* unsupported — requested, never required */
    }
    this.job = this.run().finally(() => {
      this.job = null;
      this.abort = null;
    });
    return this.job;
  }

  /** Abort the download and land on the true remaining size (REQ-6). */
  cancel(): void {
    this.stop('cancel');
  }

  private set(state: OfflineState): void {
    this.current = state;
    this.listeners.emit(state);
  }

  private unsupportedReason(): 'dev' | 'browser' | null {
    if (!this.deps.enabled) return 'dev';
    if (!this.deps.caches || !this.deps.serviceWorker || !this.deps.fetch) return 'browser';
    return null;
  }

  private stop(reason: 'cancel' | 'takeover'): void {
    if (!this.abort || this.abort.signal.aborted) return;
    this.stopReason = reason;
    this.abort.abort();
  }

  private openCache(): Promise<Cache> {
    return this.deps.caches!.open(offlineCacheName(this.deps.version));
  }

  private async inspect(): Promise<OfflineState> {
    const unknownSize: OfflineState = { kind: 'none', totalBytes: null, remainingBytes: null };
    try {
      if (await this.otherVersionInCharge()) return { kind: 'needs-reload' };
      const cache = await this.openCache();
      const marker = await readMarker(cache, this.deps.version);
      if (marker) {
        const hits = await Promise.all(marker.files.map((u) => cache.match(u, MATCH)));
        if (hits.every(Boolean)) {
          return { kind: 'complete', files: marker.files.length, totalBytes: marker.totalBytes, persisted: await this.persisted() };
        }
      }
      const manifest = await this.fetchManifest();
      if (!manifest) return unknownSize;
      const missing = await missingFiles(cache, manifest.files);
      return { kind: 'none', totalBytes: manifest.totalBytes, remainingBytes: sumBytes(missing) };
    } catch {
      return unknownSize;
    }
  }

  /** A worker of another version is active and none of ours is on the way. */
  private async otherVersionInCharge(): Promise<boolean> {
    const reg = await this.deps.serviceWorker!.getRegistration();
    if (!reg?.active) return false;
    const v = this.deps.version;
    if (workerVersion(reg.active) === v) return false;
    return workerVersion(reg.installing) !== v && workerVersion(reg.waiting) !== v;
  }

  private async fetchManifest(signal?: AbortSignal): Promise<OfflineManifest | null> {
    try {
      const res = await this.deps.fetch!(OFFLINE_MANIFEST_URL, { cache: 'no-cache', signal });
      if (!res.ok) return null;
      return parseOfflineManifest(await res.json(), this.deps.version);
    } catch {
      return null;
    }
  }

  private async persisted(): Promise<boolean> {
    try {
      return (await this.deps.storage?.persisted?.()) ?? false;
    } catch {
      return false;
    }
  }

  private async lacksSpace(bytes: number): Promise<boolean> {
    try {
      const est = await this.deps.storage?.estimate?.();
      if (!est || est.quota === undefined || est.usage === undefined) return false;
      return est.quota - est.usage < bytes;
    } catch {
      return false;
    }
  }

  private async run(): Promise<void> {
    const sw = this.deps.serviceWorker!;
    const abort = new AbortController();
    this.abort = abort;
    this.stopReason = null;
    // A new release's worker taking over purges this version's cache on
    // activate, so everything written from here on would be thrown away. The
    // first visit's clients.claim() is this version, and is not a takeover.
    const onControllerChange = (): void => {
      const v = workerVersion(sw.controller);
      if (v !== null && v !== this.deps.version) this.stop('takeover');
    };
    sw.addEventListener('controllerchange', onControllerChange);
    this.set({ kind: 'downloading', doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0 });
    let next: OfflineState;
    try {
      next = await this.download(abort.signal);
    } catch {
      next = { kind: 'error', reason: 'worker', failed: 0 };
    } finally {
      sw.removeEventListener('controllerchange', onControllerChange);
    }
    if (abort.signal.aborted) next = this.stopReason === 'takeover' ? { kind: 'needs-reload' } : await this.inspect();
    this.set(next);
  }

  /** REQ-5, in order. An aborted run's result is replaced by `run`. */
  private async download(signal: AbortSignal): Promise<OfflineState> {
    const plan = await this.prepare(signal);
    if (!('cache' in plan)) return plan;
    const { failed, outOfSpace } = await this.fetchMissing(plan, signal);
    if (signal.aborted) return this.current;
    if (outOfSpace) return { kind: 'error', reason: 'storage', failed };
    if (failed > 0) return { kind: 'error', reason: 'files', failed };
    try {
      await plan.cache.put(OFFLINE_MARKER_URL, markerResponse(plan.manifest));
    } catch (err) {
      return { kind: 'error', reason: isQuotaError(err) ? 'storage' : 'worker', failed: 0 };
    }
    const { manifest } = plan;
    return { kind: 'complete', files: manifest.files.length, totalBytes: manifest.totalBytes, persisted: await this.persisted() };
  }

  /** Steps 2–4: this version's worker, the file list, and room for what is missing. */
  private async prepare(signal: AbortSignal): Promise<Plan | OfflineState> {
    const worker = await this.waitForWorker(signal);
    if (worker === 'other') return { kind: 'needs-reload' };
    if (worker === 'none') return { kind: 'error', reason: 'worker', failed: 0 };
    if (signal.aborted) return this.current;

    const manifest = await this.fetchManifest(signal);
    if (signal.aborted) return this.current;
    if (!manifest) return { kind: 'error', reason: 'offline', failed: 0 };

    const cache = await this.openCache();
    const missing = await missingFiles(cache, manifest.files);
    if (await this.lacksSpace(sumBytes(missing))) return { kind: 'error', reason: 'storage', failed: 0 };
    return { cache, manifest, missing };
  }

  /**
   * Step 5: `concurrency` fetches at a time into the cache. A failed file does not
   * stop the others; a full disk does. Progress counts declared bytes, not
   * Content-Length — the total is fixed before the first fetch (compression would
   * make a live one wander), and already-cached files count as done, so the bar
   * opens at what this device already holds.
   */
  private async fetchMissing(
    { cache, manifest, missing }: Plan,
    signal: AbortSignal,
  ): Promise<{ failed: number; outOfSpace: boolean }> {
    const fetchFn = this.deps.fetch!;
    const totalFiles = manifest.files.length;
    let doneFiles = totalFiles - missing.length;
    let doneBytes = manifest.totalBytes - sumBytes(missing);
    const report = (): void =>
      this.set({ kind: 'downloading', doneFiles, totalFiles, doneBytes, totalBytes: manifest.totalBytes });
    report();

    let failed = 0;
    let outOfSpace = false;
    const queue = [...missing];
    const lane = async (): Promise<void> => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        if (signal.aborted || outOfSpace) return;
        try {
          const res = await fetchFn(file.url, { cache: 'no-cache', signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await cache.put(file.url, res);
        } catch (err) {
          if (signal.aborted) return;
          if (isQuotaError(err)) outOfSpace = true;
          failed++;
          continue;
        }
        doneFiles++;
        doneBytes += file.bytes;
        report();
      }
    };
    const lanes = Math.max(1, Math.min(this.deps.concurrency ?? 4, queue.length));
    await Promise.all(Array.from({ length: lanes }, lane));
    return { failed, outOfSpace };
  }

  /**
   * Step 2: wait until this version's worker is active. A worker of ours
   * installing or waiting is worth waiting for however long it takes — its
   * install may itself be refreshing an offline copy (REQ-7). Anything else gets
   * `readyTimeoutMs`.
   */
  private async waitForWorker(signal: AbortSignal): Promise<'ready' | 'other' | 'none' | 'aborted'> {
    const { version, readyTimeoutMs = 15_000, pollMs = 250 } = this.deps;
    const sw = this.deps.serviceWorker!;
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (signal.aborted) return 'aborted';
      const reg = await sw.getRegistration();
      if (workerVersion(reg?.active) === version) return 'ready';
      const oursOnTheWay = workerVersion(reg?.installing) === version || workerVersion(reg?.waiting) === version;
      if (!oursOnTheWay && Date.now() >= deadline) return reg ? 'other' : 'none';
      await delay(pollMs, signal);
    }
  }
}

declare const __APP_VERSION__: string;

let instance: OfflineCopy | null = null;

/** The page's one instance, so a download outlives the About card (REQ-3). */
export function getOfflineCopy(): OfflineCopy {
  instance ??= new OfflineCopy({
    enabled: import.meta.env.PROD,
    version: __APP_VERSION__,
    ...browserCacheDeps(),
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    storage: typeof navigator === 'undefined' ? undefined : navigator.storage,
  });
  return instance;
}
