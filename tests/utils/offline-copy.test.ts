import { describe, it, expect, vi } from 'vitest';
import {
  OfflineCopy,
  OFFLINE_MANIFEST_URL,
  OFFLINE_MARKER_URL,
  deleteOfflineCopies,
  offlineCacheName,
  parseOfflineManifest,
  type OfflineCopyDeps,
  type OfflineManifest,
  type OfflineState,
} from '../../src/utils/offline-copy';
import { CASE_VERSION, INVALID_MANIFESTS, VALID_MANIFESTS } from '../fixtures/offline-manifest-cases';
import { FakeCacheStorage, type FakeCache } from '../fixtures/offline-fakes';

/**
 * The Play offline state machine (specs/features/play-offline.md REQ-3..REQ-6),
 * driven against in-memory stand-ins for CacheStorage, fetch, the service-worker
 * container and StorageManager — no DOM, no network.
 */

const VERSION = '1.0.0';
const ORIGIN = 'https://example.com';

const MANIFEST: OfflineManifest = {
  version: VERSION,
  files: [
    { url: '/', bytes: 100 },
    { url: '/assets/index-abc.js', bytes: 400 },
    { url: '/assets/demo-def.json', bytes: 500 },
  ],
  totalBytes: 1000,
};

type Route = () => Promise<Response>;

const worker = (v: string) => ({ scriptURL: `${ORIGIN}/sw.js?v=${v}` }) as ServiceWorker;

interface Harness {
  copy: OfflineCopy;
  cache: FakeCache;
  storage: FakeCacheStorage;
  fetch: ReturnType<typeof vi.fn>;
  routes: Map<string, Route>;
  sw: EventTarget & { controller: ServiceWorker | null; reg: Record<string, ServiceWorker | null> | undefined };
  quota: { persist: ReturnType<typeof vi.fn>; persisted: ReturnType<typeof vi.fn>; estimate: ReturnType<typeof vi.fn> };
  states: OfflineState[];
}

function harness(overrides: Partial<OfflineCopyDeps> = {}): Harness {
  const storage = new FakeCacheStorage();
  const cache = storage.cache(offlineCacheName(VERSION));
  const routes = new Map<string, Route>();
  routes.set(OFFLINE_MANIFEST_URL, async () => new Response(JSON.stringify(MANIFEST)));
  for (const f of MANIFEST.files) routes.set(f.url, async () => new Response(`body of ${f.url}`));

  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const route = routes.get(url);
    if (!route) return new Response('nope', { status: 404 });
    return route();
  });

  const sw = Object.assign(new EventTarget(), {
    controller: null as ServiceWorker | null,
    reg: { active: worker(VERSION), installing: null, waiting: null } as Record<string, ServiceWorker | null> | undefined,
    getRegistration: async () => sw.reg,
  });

  const quota = {
    // Never settles, like a Firefox prompt nobody has answered: a download that
    // awaited it would hang, which is exactly what REQ-5 step 1 forbids.
    persist: vi.fn(() => new Promise<boolean>(() => {})),
    persisted: vi.fn(async () => true),
    estimate: vi.fn(async () => ({ quota: 1e9, usage: 0 })),
  };

  const copy = new OfflineCopy({
    enabled: true,
    version: VERSION,
    caches: storage.asCacheStorage,
    fetch: fetch as unknown as OfflineCopyDeps['fetch'],
    serviceWorker: sw as unknown as ServiceWorkerContainer,
    storage: quota as unknown as StorageManager,
    readyTimeoutMs: 40,
    pollMs: 5,
    ...overrides,
  });
  const states: OfflineState[] = [];
  copy.subscribe((s) => states.push(s));
  return { copy, cache, storage, fetch, routes, sw, quota, states };
}

const cacheAll = (cache: FakeCache, urls: string[]) => {
  for (const u of urls) cache.store.set(u, new Response(`cached ${u}`));
};

const writeMarker = (cache: FakeCache, version = VERSION) =>
  cache.store.set(OFFLINE_MARKER_URL, new Response(JSON.stringify({
    version, files: MANIFEST.files.map((f) => f.url), totalBytes: MANIFEST.totalBytes, completedAt: 'x',
  })));

describe('parseOfflineManifest (REQ-9)', () => {
  it('accepts its own version and recomputes the total', () => {
    const m = parseOfflineManifest({ ...MANIFEST, totalBytes: 1 }, VERSION);
    expect(m?.totalBytes).toBe(1000);
  });

  // The same table tests/pwa/sw.test.ts runs against the worker's parser.
  it.each(VALID_MANIFESTS)('accepts %s', (_label, raw) => {
    expect(parseOfflineManifest(raw, CASE_VERSION)).not.toBeNull();
  });

  it.each(INVALID_MANIFESTS)('rejects %s', (_label, raw) => {
    expect(parseOfflineManifest(raw, CASE_VERSION)).toBeNull();
  });
});

describe('deleteOfflineCopies (REQ-12)', () => {
  it('deletes every app cache, keeps foreign ones, and reports the complete copy', async () => {
    const storage = FakeCacheStorage.with({
      [offlineCacheName('1.0.0')]: [OFFLINE_MARKER_URL, '/'],
      [offlineCacheName('0.9.0')]: ['/'],
      'not-ours': ['/x'],
    });
    await expect(deleteOfflineCopies(storage.asCacheStorage)).resolves.toEqual({ hadCopy: true });
    expect([...storage.caches.keys()]).toEqual(['not-ours']);
  });

  it('reports no copy when only runtime caches existed', async () => {
    const storage = FakeCacheStorage.with({ [offlineCacheName('1.0.0')]: ['/'] });
    await expect(deleteOfflineCopies(storage.asCacheStorage)).resolves.toEqual({ hadCopy: false });
    expect(storage.caches.size).toBe(0);
  });
});

describe('unsupported (REQ-3, REQ-4)', () => {
  it('is unsupported on the dev server, and start() fetches nothing', async () => {
    const h = harness({ enabled: false });
    await h.copy.refresh();
    expect(h.copy.state).toEqual({ kind: 'unsupported', reason: 'dev' });
    await h.copy.start();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('is unsupported without Cache Storage or a service worker', async () => {
    const noCaches = harness({ caches: undefined });
    await noCaches.copy.refresh();
    expect(noCaches.copy.state).toEqual({ kind: 'unsupported', reason: 'browser' });

    const noWorker = harness({ serviceWorker: undefined });
    await noWorker.copy.refresh();
    expect(noWorker.copy.state).toEqual({ kind: 'unsupported', reason: 'browser' });
  });
});

describe('refresh (REQ-4)', () => {
  it('reports the remaining size when part of the app is already cached', async () => {
    const h = harness();
    cacheAll(h.cache, ['/', '/assets/index-abc.js']);
    await h.copy.refresh();
    expect(h.copy.state).toEqual({ kind: 'none', totalBytes: 1000, remainingBytes: 500 });
  });

  it('recognises a complete copy from the marker and every file it lists', async () => {
    const h = harness();
    cacheAll(h.cache, MANIFEST.files.map((f) => f.url));
    writeMarker(h.cache);
    await h.copy.refresh();
    expect(h.copy.state).toEqual({ kind: 'complete', files: 3, totalBytes: 1000, persisted: true });
    // The manifest is not needed to know that.
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('counts a file the worker cached with a Vary header as saved (REQ-11, regression)', async () => {
    const h = harness();
    for (const f of MANIFEST.files) {
      h.cache.store.set(f.url, new Response('runtime-cached', { headers: { Vary: 'Origin' } }));
    }
    writeMarker(h.cache);
    await h.copy.refresh();
    expect(h.copy.state.kind).toBe('complete');

    h.cache.store.delete(OFFLINE_MARKER_URL);
    await h.copy.refresh();
    expect(h.copy.state).toEqual({ kind: 'none', totalBytes: 1000, remainingBytes: 0 });
  });

  it('is not complete when the browser evicted a listed file', async () => {
    const h = harness();
    cacheAll(h.cache, ['/', '/assets/index-abc.js']);
    writeMarker(h.cache);
    await h.copy.refresh();
    expect(h.copy.state).toMatchObject({ kind: 'none', remainingBytes: 500 });
  });

  it('ignores a marker left by another version', async () => {
    const h = harness();
    cacheAll(h.cache, MANIFEST.files.map((f) => f.url));
    writeMarker(h.cache, '0.9.0');
    await h.copy.refresh();
    expect(h.copy.state).toMatchObject({ kind: 'none', remainingBytes: 0 });
  });

  it('has no size to report when the list cannot be fetched', async () => {
    const h = harness();
    h.routes.delete(OFFLINE_MANIFEST_URL);
    await h.copy.refresh();
    expect(h.copy.state).toEqual({ kind: 'none', totalBytes: null, remainingBytes: null });
  });

  it('asks for a reload when another version is in charge and none of ours is on the way', async () => {
    const h = harness();
    h.sw.reg = { active: worker('2.0.0'), installing: null, waiting: null };
    await h.copy.refresh();
    expect(h.copy.state).toEqual({ kind: 'needs-reload' });
  });

  it('does not ask for a reload while our own worker is installing', async () => {
    const h = harness();
    h.sw.reg = { active: worker('0.9.0'), installing: worker(VERSION), waiting: null };
    await h.copy.refresh();
    expect(h.copy.state.kind).toBe('none');
  });
});

describe('start (REQ-5)', () => {
  it('downloads what is missing, reports forward-only progress, then writes the marker', async () => {
    const h = harness();
    cacheAll(h.cache, ['/']);
    await h.copy.start();

    expect(h.quota.persist).toHaveBeenCalledTimes(1);
    const fetched = h.fetch.mock.calls.map((c) => c[0] as string);
    expect(fetched).toContain(OFFLINE_MANIFEST_URL);
    expect(fetched).not.toContain('/'); // already cached — skipped
    expect(fetched).toEqual(expect.arrayContaining(['/assets/index-abc.js', '/assets/demo-def.json']));
    for (const call of h.fetch.mock.calls) expect((call[1] as RequestInit).cache).toBe('no-cache');

    const progress = h.states.filter((s) => s.kind === 'downloading' && s.totalFiles > 0) as
      Extract<OfflineState, { kind: 'downloading' }>[];
    expect(progress[0]).toMatchObject({ doneFiles: 1, doneBytes: 100, totalFiles: 3, totalBytes: 1000 });
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.doneBytes).toBeGreaterThanOrEqual(progress[i - 1]!.doneBytes);
    }
    expect(progress.at(-1)).toMatchObject({ doneFiles: 3, doneBytes: 1000 });

    expect(h.copy.state).toEqual({ kind: 'complete', files: 3, totalBytes: 1000, persisted: true });
    // Everything went into this version's cache, and only there.
    expect([...h.storage.caches.keys()]).toEqual([offlineCacheName(VERSION)]);
    const marker = await (await h.cache.match(OFFLINE_MARKER_URL))!.json();
    expect(marker).toMatchObject({ version: VERSION, files: ['/', '/assets/index-abc.js', '/assets/demo-def.json'], totalBytes: 1000 });
  });

  it('opens with a preparing state before the list is known', async () => {
    const h = harness();
    const run = h.copy.start();
    expect(h.copy.state).toEqual({ kind: 'downloading', doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0 });
    await run;
  });

  it('keeps what succeeded, writes no marker, and counts the failure', async () => {
    const h = harness();
    h.routes.set('/assets/demo-def.json', async () => new Response('gone', { status: 404 }));
    await h.copy.start();
    expect(h.copy.state).toEqual({ kind: 'error', reason: 'files', failed: 1 });
    expect(h.cache.store.has('/assets/index-abc.js')).toBe(true);
    expect(h.cache.store.has(OFFLINE_MARKER_URL)).toBe(false);
  });

  it('stops before downloading when the files will not fit', async () => {
    const h = harness();
    h.quota.estimate.mockResolvedValue({ quota: 1000, usage: 600 });
    await h.copy.start();
    expect(h.copy.state).toEqual({ kind: 'error', reason: 'storage', failed: 0 });
    expect(h.fetch.mock.calls.map((c) => c[0])).toEqual([OFFLINE_MANIFEST_URL]);
  });

  it('reports storage when the cache refuses a write', async () => {
    const h = harness();
    h.cache.putError = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    await h.copy.start();
    expect(h.copy.state).toMatchObject({ kind: 'error', reason: 'storage' });
  });

  it('reports offline when the list cannot be fetched', async () => {
    const h = harness();
    h.routes.set(OFFLINE_MANIFEST_URL, async () => { throw new TypeError('Failed to fetch'); });
    await h.copy.start();
    expect(h.copy.state).toEqual({ kind: 'error', reason: 'offline', failed: 0 });
  });

  it('asks for a reload when another version stays in charge', async () => {
    const h = harness();
    h.sw.reg = { active: worker('2.0.0'), installing: null, waiting: null };
    await h.copy.start();
    expect(h.copy.state).toEqual({ kind: 'needs-reload' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reports the worker when there is no registration at all', async () => {
    const h = harness();
    h.sw.reg = undefined;
    await h.copy.start();
    expect(h.copy.state).toEqual({ kind: 'error', reason: 'worker', failed: 0 });
  });

  it('waits past the timeout for our own installing worker, then downloads', async () => {
    const h = harness({ readyTimeoutMs: 10 });
    h.sw.reg = { active: null, installing: worker(VERSION), waiting: null };
    setTimeout(() => { h.sw.reg = { active: worker(VERSION), installing: null, waiting: null }; }, 60);
    await h.copy.start();
    expect(h.copy.state.kind).toBe('complete');
  });

  it('joins a run already in flight instead of starting a second', async () => {
    const h = harness();
    const a = h.copy.start();
    const b = h.copy.start();
    expect(b).toBe(a);
    await a;
    expect(h.fetch.mock.calls.filter((c) => c[0] === OFFLINE_MANIFEST_URL)).toHaveLength(1);
  });

  it('repairs a complete copy: skips everything cached and rewrites the marker', async () => {
    const h = harness();
    cacheAll(h.cache, MANIFEST.files.map((f) => f.url));
    await h.copy.start();
    expect(h.fetch.mock.calls.map((c) => c[0])).toEqual([OFFLINE_MANIFEST_URL]);
    expect(h.copy.state.kind).toBe('complete');
    expect(h.cache.store.has(OFFLINE_MARKER_URL)).toBe(true);
  });
});

/** Make one file's fetch hang until its signal aborts. */
function hang(h: Harness, url: string): Promise<void> {
  return new Promise((reached) => {
    h.fetch.mockImplementation(async (u: string, init?: RequestInit) => {
      const route = h.routes.get(u);
      if (u !== url) return route ? route() : new Response('nope', { status: 404 });
      reached();
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
  });
}

describe('cancel and takeover (REQ-6)', () => {
  it('cancel aborts and lands on the true remaining size', async () => {
    const h = harness();
    const reached = hang(h, '/assets/demo-def.json');
    const run = h.copy.start();
    await reached;
    h.copy.cancel();
    await run;
    expect(h.copy.state).toEqual({ kind: 'none', totalBytes: 1000, remainingBytes: 500 });
    expect(h.cache.store.has(OFFLINE_MARKER_URL)).toBe(false);
  });

  it('a new version taking control aborts to needs-reload', async () => {
    const h = harness();
    const reached = hang(h, '/assets/demo-def.json');
    const run = h.copy.start();
    await reached;
    h.sw.controller = worker('2.0.0');
    h.sw.dispatchEvent(new Event('controllerchange'));
    await run;
    expect(h.copy.state).toEqual({ kind: 'needs-reload' });
  });

  it("the first visit's claim by this version is not a takeover", async () => {
    const h = harness();
    const reached = hang(h, '/assets/demo-def.json');
    const run = h.copy.start();
    await reached;
    h.sw.controller = worker(VERSION);
    h.sw.dispatchEvent(new Event('controllerchange'));
    expect(h.copy.state.kind).toBe('downloading');
    h.copy.cancel();
    await run;
  });

  it('refresh while downloading changes nothing', async () => {
    const h = harness();
    const reached = hang(h, '/assets/demo-def.json');
    const run = h.copy.start();
    await reached;
    const before = h.copy.state;
    await h.copy.refresh();
    expect(h.copy.state).toBe(before);
    h.copy.cancel();
    await run;
  });
});
