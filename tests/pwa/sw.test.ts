import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  OFFLINE_CACHE_PREFIX,
  OFFLINE_MANIFEST_URL,
  OFFLINE_MARKER_URL,
  offlineCacheName,
} from '../../src/utils/offline-copy';
import { CASE_VERSION, INVALID_MANIFESTS, VALID_MANIFESTS } from '../fixtures/offline-manifest-cases';

/**
 * Drives the real `public/sw.js` under Node by stubbing the ServiceWorker
 * globals before importing it — the same pattern as the compressor-worklet
 * suite. The pure decision helpers come from the `self.__sw` test hook; the
 * install/activate/fetch handlers are the captured listeners, invoked with
 * fake events against a Map-backed CacheStorage mock.
 */

const ORIGIN = 'https://example.com';
const SW_URL = `${ORIGIN}/sw.js?v=9.9.9`; // current cache: websynth-9.9.9

interface SwTestHook {
  cacheName(swUrl: string): string;
  isHashedAsset(pathname: string): boolean;
  strategyFor(url: URL, mode: string, method: string, origin: string): string;
  CORE_ASSETS: string[];
  CACHE_PREFIX: string;
  OFFLINE_MARKER: string;
  OFFLINE_MANIFEST: string;
  parseManifest(raw: unknown, version: string): unknown;
}

type Listener = (event: unknown) => void;

const listeners: Record<string, Listener> = {};
let sw: SwTestHook;
let fakeSelf: {
  addEventListener: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
  clients: { claim: ReturnType<typeof vi.fn> };
  location: { href: string; origin: string };
  __sw?: SwTestHook;
};

/** Key requests by pathname so string keys ('/') and Requests interoperate. */
const keyOf = (req: unknown): string => {
  const url = typeof req === 'string' ? req : (req as { url: string }).url;
  return url.startsWith('http') ? new URL(url).pathname : url;
};

/**
 * A stored entry flagged `vary: true` stands for a response carrying `Vary:
 * Origin` that was saved by a request without that header — the real cache then
 * misses unless the lookup passes `ignoreVary` (play-offline.md REQ-cache-lookups-ignore-vary).
 */
const hitOf = (entry: unknown, opts?: { ignoreVary?: boolean }): unknown =>
  entry && (entry as { vary?: boolean }).vary && !opts?.ignoreVary ? undefined : entry;

let cacheStores: Map<string, Map<string, unknown>>;
let fakeCaches: {
  open: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
};

function resetCaches(names: string[] = []): void {
  cacheStores = new Map(names.map((n) => [n, new Map()]));
  const openStore = (name: string) => {
    if (!cacheStores.has(name)) cacheStores.set(name, new Map());
    const store = cacheStores.get(name)!;
    return {
      addAll: vi.fn(async (urls: string[]) => {
        for (const u of urls) store.set(keyOf(u), { cachedUrl: u });
      }),
      put: vi.fn(async (req: unknown, res: unknown) => {
        store.set(keyOf(req), res);
      }),
      match: vi.fn(async (req: unknown, opts?: { ignoreVary?: boolean }) => hitOf(store.get(keyOf(req)), opts)),
    };
  };
  fakeCaches = {
    open: vi.fn(async (n: string) => openStore(n)),
    keys: vi.fn(async () => [...cacheStores.keys()]),
    delete: vi.fn(async (n: string) => cacheStores.delete(n)),
    match: vi.fn(async (req: unknown, opts?: { ignoreVary?: boolean }) => {
      for (const store of cacheStores.values()) {
        const hit = hitOf(store.get(keyOf(req)), opts);
        if (hit) return hit;
      }
      return undefined;
    }),
  };
  vi.stubGlobal('caches', fakeCaches);
}

/** A fetch-event stand-in capturing what respondWith was given. */
function makeFetchEvent(url: string, mode = 'no-cors', method = 'GET') {
  let responded: Promise<unknown> | null = null;
  return {
    request: { url, mode, method },
    respondWith: vi.fn((p: Promise<unknown>) => { responded = p; }),
    response: () => responded,
  };
}

const waitUntil = () => {
  let p: Promise<unknown> = Promise.resolve();
  return {
    waitUntil: vi.fn((x: Promise<unknown>) => { p = x; }),
    settled: () => p,
  };
};

beforeAll(async () => {
  fakeSelf = {
    addEventListener: vi.fn((type: string, cb: Listener) => { listeners[type] = cb; }),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    location: { href: SW_URL, origin: ORIGIN },
  };
  vi.stubGlobal('self', fakeSelf);
  resetCaches();
  await import('../../public/sw.js' as string);
  sw = fakeSelf.__sw!;
});

beforeEach(() => {
  resetCaches();
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network disabled in this test');
  }));
});

describe('cacheName', () => {
  it('derives the cache from the ?v= registration query', () => {
    expect(sw.cacheName('https://x/sw.js?v=1.2.3')).toBe('websynth-1.2.3');
  });
  it("falls back to 'dev' without a version query", () => {
    expect(sw.cacheName('https://x/sw.js')).toBe('websynth-dev');
  });
});

describe('strategyFor', () => {
  const at = (path: string) => new URL(ORIGIN + path);

  it('cache-first for hashed /assets/*', () => {
    expect(sw.strategyFor(at('/assets/index-abc123.js'), 'no-cors', 'GET', ORIGIN)).toBe('cache-first');
    expect(sw.strategyFor(at('/assets/demos-def456.js'), 'no-cors', 'GET', ORIGIN)).toBe('cache-first');
  });

  it('network-first-nav for navigations', () => {
    expect(sw.strategyFor(at('/'), 'navigate', 'GET', ORIGIN)).toBe('network-first-nav');
    expect(sw.strategyFor(at('/anything'), 'navigate', 'GET', ORIGIN)).toBe('network-first-nav');
  });

  it('network-first for other same-origin GETs (worklets, manifest, icons)', () => {
    expect(sw.strategyFor(at('/worklets/compressor.js'), 'no-cors', 'GET', ORIGIN)).toBe('network-first');
    expect(sw.strategyFor(at('/site.webmanifest'), 'no-cors', 'GET', ORIGIN)).toBe('network-first');
  });

  it('passthrough for non-GET and cross-origin requests', () => {
    expect(sw.strategyFor(at('/api'), 'no-cors', 'POST', ORIGIN)).toBe('passthrough');
    expect(sw.strategyFor(new URL('https://elsewhere.com/x.js'), 'no-cors', 'GET', ORIGIN)).toBe('passthrough');
  });

  // pwa-install.md REQ-service-worker-is-registered / mcp-server.md REQ-no-sse-every-response-is-one-json-body. The POST case above already
  // covers real MCP traffic; these pin the GET shapes, which is where the
  // guarantee stops being accidental — a 405 happens not to be cacheable, but
  // that is the endpoint's business, not the worker's.
  it('passes the MCP endpoint through on GET too, not just POST', () => {
    expect(sw.strategyFor(at('/mcp'), 'no-cors', 'GET', ORIGIN)).toBe('passthrough');
    expect(sw.strategyFor(at('/mcp/'), 'no-cors', 'GET', ORIGIN)).toBe('passthrough');
    expect(sw.strategyFor(at('/healthz'), 'no-cors', 'GET', ORIGIN)).toBe('passthrough');
    // Even as a navigation, which would otherwise fall back to the cached shell.
    expect(sw.strategyFor(at('/mcp'), 'navigate', 'GET', ORIGIN)).toBe('passthrough');
  });

  it('does not swallow an app route that merely starts with the same letters', () => {
    expect(sw.strategyFor(at('/mcp-guide'), 'navigate', 'GET', ORIGIN)).toBe('network-first-nav');
  });
});

describe('install', () => {
  it('precaches the core shell into the versioned cache and skips waiting', async () => {
    const ev = waitUntil();
    listeners['install']!(ev);
    await ev.settled();
    expect(fakeCaches.open).toHaveBeenCalledWith('websynth-9.9.9');
    const store = cacheStores.get('websynth-9.9.9')!;
    for (const asset of sw.CORE_ASSETS) expect(store.has(keyOf(asset))).toBe(true);
    expect(sw.CORE_ASSETS).toContain('/worklets/ladder-filter.js');
    expect(fakeSelf.skipWaiting).toHaveBeenCalled();
  });
});

describe('activate', () => {
  it('purges other websynth-* caches, keeps the current one and foreign caches', async () => {
    resetCaches(['websynth-1.0.0', 'websynth-9.9.9', 'not-ours']);
    const ev = waitUntil();
    listeners['activate']!(ev);
    await ev.settled();
    expect([...cacheStores.keys()]).toEqual(['websynth-9.9.9', 'not-ours']);
    expect(fakeSelf.clients.claim).toHaveBeenCalled();
  });
});

describe('fetch', () => {
  it('serves a cached hashed asset without touching the network', async () => {
    resetCaches(['websynth-9.9.9']);
    cacheStores.get('websynth-9.9.9')!.set('/assets/index-abc.js', { body: 'js' });
    const ev = makeFetchEvent(`${ORIGIN}/assets/index-abc.js`);
    listeners['fetch']!(ev);
    await expect(ev.response()).resolves.toEqual({ body: 'js' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the cached "/" for a navigation while offline', async () => {
    resetCaches(['websynth-9.9.9']);
    cacheStores.get('websynth-9.9.9')!.set('/', { body: 'shell' });
    const ev = makeFetchEvent(`${ORIGIN}/some/route`, 'navigate');
    listeners['fetch']!(ev);
    await expect(ev.response()).resolves.toEqual({ body: 'shell' });
  });

  it('serves a cached same-origin file while offline (network-first fallback)', async () => {
    resetCaches(['websynth-9.9.9']);
    cacheStores.get('websynth-9.9.9')!.set('/worklets/recorder.js', { body: 'worklet' });
    const ev = makeFetchEvent(`${ORIGIN}/worklets/recorder.js`);
    listeners['fetch']!(ev);
    await expect(ev.response()).resolves.toEqual({ body: 'worklet' });
  });

  it('prefers the network when online and caches the fresh response', async () => {
    const fresh = { status: 200, type: 'basic', clone: () => ({ cloned: true }) };
    vi.stubGlobal('fetch', vi.fn(async () => fresh));
    const ev = makeFetchEvent(`${ORIGIN}/site.webmanifest`);
    listeners['fetch']!(ev);
    await expect(ev.response()).resolves.toBe(fresh);
    // The clone lands in the versioned cache (async put — allow a microtask).
    await new Promise((r) => setTimeout(r, 0));
    expect(cacheStores.get('websynth-9.9.9')!.get('/site.webmanifest')).toEqual({ cloned: true });
  });

  // play-offline.md REQ-cache-lookups-ignore-vary (regression). The first real-browser pass saved every
  // file and still failed its offline boot: the host sent `Vary: Origin`, the
  // page's fetch() had no Origin header, and the module script asking for the
  // chunk did — so the lookup missed a file that was sitting in the cache.
  it('serves a saved hashed asset whose response varies on a header the script request differs in', async () => {
    resetCaches(['websynth-9.9.9']);
    cacheStores.get('websynth-9.9.9')!.set('/assets/index-abc.js', { body: 'js', vary: true });
    const ev = makeFetchEvent(`${ORIGIN}/assets/index-abc.js`, 'cors');
    listeners['fetch']!(ev);
    await expect(ev.response()).resolves.toEqual({ body: 'js', vary: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to a varying cached file, and to a varying "/", while offline', async () => {
    resetCaches(['websynth-9.9.9']);
    const store = cacheStores.get('websynth-9.9.9')!;
    store.set('/worklets/recorder.js', { body: 'worklet', vary: true });
    store.set('/', { body: 'shell', vary: true });

    const file = makeFetchEvent(`${ORIGIN}/worklets/recorder.js`);
    listeners['fetch']!(file);
    await expect(file.response()).resolves.toEqual({ body: 'worklet', vary: true });

    const nav = makeFetchEvent(`${ORIGIN}/some/route`, 'navigate');
    listeners['fetch']!(nav);
    await expect(nav.response()).resolves.toEqual({ body: 'shell', vary: true });
  });

  it('does not intercept cross-origin or non-GET requests', () => {
    const cross = makeFetchEvent('https://elsewhere.com/lib.js');
    listeners['fetch']!(cross);
    expect(cross.respondWith).not.toHaveBeenCalled();

    const post = makeFetchEvent(`${ORIGIN}/api`, 'no-cors', 'POST');
    listeners['fetch']!(post);
    expect(post.respondWith).not.toHaveBeenCalled();
  });
});

// ---- the offline copy across releases (play-offline.md REQ-the-copy-survives-a-release, REQ-the-manifest-is-same-origin-build-output, REQ-one-offline-marker-contract) ----

describe('page and worker agree (play-offline.md REQ-one-offline-marker-contract)', () => {
  it('spell the marker, the manifest, the cache prefix and the cache name the same way', () => {
    expect(sw.OFFLINE_MARKER).toBe(OFFLINE_MARKER_URL);
    expect(sw.OFFLINE_MANIFEST).toBe(OFFLINE_MANIFEST_URL);
    // A factory reset deletes by the page's prefix (play-offline.md REQ-the-copy-is-fetched-again-after-a-reset), so a
    // renamed worker cache would otherwise outlive it.
    expect(sw.CACHE_PREFIX).toBe(OFFLINE_CACHE_PREFIX);
    expect(sw.cacheName('https://x/sw.js?v=4.5.6')).toBe(offlineCacheName('4.5.6'));
  });
});

describe('parseManifest (play-offline.md REQ-the-manifest-is-same-origin-build-output)', () => {
  // The same table tests/utils/offline-copy.test.ts runs against the page's parser.
  it.each(VALID_MANIFESTS)('accepts %s', (_label, raw) => {
    expect(sw.parseManifest(raw, CASE_VERSION)).not.toBeNull();
  });

  it.each(INVALID_MANIFESTS)('rejects %s', (_label, raw) => {
    expect(sw.parseManifest(raw, CASE_VERSION)).toBeNull();
  });
});

describe('install refreshes an offline copy (play-offline.md REQ-the-copy-survives-a-release)', () => {
  const OLD = 'websynth-1.0.0';
  const NEW = 'websynth-9.9.9';
  const MANIFEST = {
    version: '9.9.9',
    files: [
      { url: '/', bytes: 10 },
      { url: '/assets/demo-abc.json', bytes: 20 }, // unchanged since 1.0.0
      { url: '/assets/new-chunk-def.js', bytes: 30 },
      { url: '/params.json', bytes: 40 },
    ],
    totalBytes: 100,
  };

  /** Serve the manifest and every listed file; `fail` answers 500 instead. */
  function serve(manifest: unknown = MANIFEST, fail: string | null = null) {
    const fetchStub = vi.fn(async (url: string) => {
      if (url === '/offline-manifest.json') return new Response(JSON.stringify(manifest));
      if (url === fail) return new Response('boom', { status: 500 });
      return new Response(`fresh ${url}`);
    });
    vi.stubGlobal('fetch', fetchStub);
    return fetchStub;
  }

  function oldCopy(): void {
    resetCaches([OLD]);
    const old = cacheStores.get(OLD)!;
    old.set('/__offline-copy', { marker: true });
    // Saved by the page's fetch() under a host that sends Vary (REQ-cache-lookups-ignore-vary).
    old.set('/assets/demo-abc.json', { body: 'old demo', vary: true });
  }

  async function install() {
    fakeSelf.skipWaiting.mockClear();
    const ev = waitUntil();
    listeners['install']!(ev);
    return ev.settled();
  }

  it('copies unchanged hashed assets, fetches the rest, and writes a new marker', async () => {
    oldCopy();
    const fetched = serve();
    await install();

    const store = cacheStores.get(NEW)!;
    for (const asset of sw.CORE_ASSETS) expect(store.has(keyOf(asset))).toBe(true);
    for (const f of MANIFEST.files) expect(store.has(f.url), f.url).toBe(true);
    // The unchanged demo came from the old cache, not the network.
    expect(store.get('/assets/demo-abc.json')).toEqual({ body: 'old demo', vary: true });
    expect(fetched.mock.calls.map((c) => c[0])).not.toContain('/assets/demo-abc.json');
    expect(fetched.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['/offline-manifest.json', '/', '/assets/new-chunk-def.js', '/params.json']),
    );

    const marker = await (store.get('/__offline-copy') as Response).json();
    expect(marker).toMatchObject({ version: '9.9.9', files: MANIFEST.files.map((f) => f.url), totalBytes: 100 });
    expect(fakeSelf.skipWaiting).toHaveBeenCalled();
  });

  it('stays core-only when no older cache holds a marker', async () => {
    resetCaches([OLD]);
    cacheStores.get(OLD)!.set('/assets/demo-abc.json', { body: 'browsed, not saved' });
    const fetched = serve();
    await install();
    expect(fetched).not.toHaveBeenCalled();
    expect(cacheStores.get(NEW)!.has('/__offline-copy')).toBe(false);
    expect(fakeSelf.skipWaiting).toHaveBeenCalled();
  });

  it('rejects the install when the manifest belongs to another version', async () => {
    oldCopy();
    serve({ ...MANIFEST, version: '10.0.0' });
    await expect(install()).rejects.toThrow(/manifest/);
    expect(fakeSelf.skipWaiting).not.toHaveBeenCalled();
    // The old worker's copy is untouched: activate (the purge) never ran.
    expect(cacheStores.get(OLD)!.has('/__offline-copy')).toBe(true);
  });

  it('rejects the install when a listed file fails', async () => {
    oldCopy();
    serve(MANIFEST, '/params.json');
    await expect(install()).rejects.toThrow(/params\.json/);
    expect(fakeSelf.skipWaiting).not.toHaveBeenCalled();
    expect(cacheStores.get(NEW)!.has('/__offline-copy')).toBe(false);
  });
});
