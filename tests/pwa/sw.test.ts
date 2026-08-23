import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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
      match: vi.fn(async (req: unknown) => store.get(keyOf(req))),
    };
  };
  fakeCaches = {
    open: vi.fn(async (n: string) => openStore(n)),
    keys: vi.fn(async () => [...cacheStores.keys()]),
    delete: vi.fn(async (n: string) => cacheStores.delete(n)),
    match: vi.fn(async (req: unknown) => {
      for (const store of cacheStores.values()) {
        const hit = store.get(keyOf(req));
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

  // pwa-install.md REQ-6 / mcp-server.md REQ-9b. The POST case above already
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

  it('does not intercept cross-origin or non-GET requests', () => {
    const cross = makeFetchEvent('https://elsewhere.com/lib.js');
    listeners['fetch']!(cross);
    expect(cross.respondWith).not.toHaveBeenCalled();

    const post = makeFetchEvent(`${ORIGIN}/api`, 'no-cors', 'POST');
    listeners['fetch']!(post);
    expect(post.respondWith).not.toHaveBeenCalled();
  });
});
