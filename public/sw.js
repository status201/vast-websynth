/**
 * Offline service worker — hand-written, dependency-free (ADR-003 discipline;
 * spec: specs/features/pwa-install.md REQ-service-worker-is-registered).
 *
 * Registered PRODUCTION-ONLY from main.ts as `/sw.js?v=<app version>` — the
 * version query names the cache (`websynth-<version>`) and makes each release
 * a byte-different registration URL, so browsers re-fetch and install the new
 * worker. NEVER register this on the dev server: it will poison Vite HMR
 * (unregister via DevTools → Application → Service Workers if you did).
 *
 * Strategy (see `strategyFor`):
 *   - non-GET / cross-origin        → passthrough (not intercepted)
 *   - /mcp, /healthz                → passthrough (the API, not the app)
 *   - /assets/* (hashed, immutable) → cache-first, miss-fill
 *   - navigations                   → network-first, fallback to cached '/'
 *   - other same-origin GETs        → network-first, cache on success
 *
 * Runtime caching by default: a visit caches what it fetched, and the app is
 * NOT one bundle (demo songs are fetched on click, several dialogs are split
 * chunks), so that covers only the surfaces the user opened. The whole app is
 * opt-in: the About card's Play offline (specs/features/play-offline.md) fills
 * this cache from the build's `offline-manifest.json` and leaves a marker, and
 * `install` below keeps that copy whole across releases (REQ-the-copy-survives-a-release there).
 *
 * Pure decision helpers are exposed on `self.__sw` so the Vitest suite
 * (tests/pwa/sw.test.ts) can import this file with stubbed globals — the
 * same pattern as the compressor worklet's unit tests.
 */
'use strict';

/**
 * Every cache this worker names starts with this, so `activate` and a factory
 * reset can tell them from anything else on the origin. The page spells it
 * `OFFLINE_CACHE_PREFIX` (src/utils/offline-copy.ts); tests/pwa/sw.test.ts pins
 * the two equal (play-offline.md REQ-one-offline-marker-contract).
 */
var CACHE_PREFIX = 'websynth-';

/** The version a registration URL carries (`?v=`), or 'dev' without one. */
function versionOf(swUrl) {
  return new URL(swUrl).searchParams.get('v') || 'dev';
}

/** Cache name for a given registration URL (the `?v=` query names it). */
function cacheName(swUrl) {
  return CACHE_PREFIX + versionOf(swUrl);
}

/** One of this app's caches, other than the current one. */
function isOlderAppCache(name) {
  return name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE;
}

/** Hashed Vite build output — immutable, safe to serve from cache forever. */
function isHashedAsset(pathname) {
  return pathname.indexOf('/assets/') === 0;
}

/**
 * Paths served from this origin by a reverse proxy rather than from `dist/`:
 * the public MCP endpoint (mcp-server.md REQ-the-http-transport-is-stateless) and its health check.
 *
 * These were already safe by accident — the traffic is POST, which the non-GET
 * rule below passes through, and `GET /mcp` answers 405, which `fetchAndCache`
 * declines to cache. Naming them makes it safe on PURPOSE: an API response has
 * no business in a cache keyed by app version, and the accident stops holding
 * the moment that endpoint ever answers a GET with 200.
 */
function isApiPath(pathname) {
  return pathname === '/mcp' || pathname.indexOf('/mcp/') === 0 || pathname === '/healthz';
}

/**
 * Classify a request. `passthrough` requests are never intercepted; the rest
 * map to the handlers below.
 */
function strategyFor(url, mode, method, origin) {
  if (method !== 'GET' || url.origin !== origin) return 'passthrough';
  if (isApiPath(url.pathname)) return 'passthrough';
  if (isHashedAsset(url.pathname)) return 'cache-first';
  if (mode === 'navigate') return 'network-first-nav';
  return 'network-first';
}

/**
 * The stable-URL shell precached at install: what boot needs besides the
 * hashed bundle — the page itself, the worklet processors loaded via
 * `audioWorklet.addModule`, and the install-surface files.
 */
var CORE_ASSETS = [
  '/',
  '/site.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/worklets/ladder-filter.js',
  '/worklets/compressor.js',
  '/worklets/recorder.js',
];

var CACHE = cacheName(self.location.href);
var VERSION = versionOf(self.location.href);

/**
 * Every lookup ignores `Vary` (play-offline.md REQ-cache-lookups-ignore-vary). Hosts send `Vary: Origin`
 * on static files, and a cache honours it by comparing request headers: a module
 * script asks WITH an Origin header, while the page's fetch() that saved the
 * file for Play offline had none — so a file sitting in the cache never matched
 * and the offline boot failed on its first chunk. These files are content-hashed
 * or version-scoped and never differ by request header.
 */
var MATCH = { ignoreVary: true };

/**
 * The offline copy's marker and file list (play-offline.md REQ-the-build-writes-the-file-list, REQ-one-offline-marker-contract). The
 * page spells the marker `OFFLINE_MARKER_URL` in src/utils/offline-copy.ts — this
 * file is outside the bundle, so tests/pwa/sw.test.ts pins the two equal.
 */
var OFFLINE_MARKER = '/__offline-copy';
var OFFLINE_MANIFEST = '/offline-manifest.json';

/**
 * Validate the build's file list: this worker's own version, and every url
 * root-relative and same-origin once resolved (`//x` and `/\x` both escape).
 * Returns the manifest or null (play-offline.md REQ-the-manifest-is-same-origin-build-output).
 */
function parseManifest(raw, version) {
  if (!raw || typeof raw !== 'object' || raw.version !== version || !Array.isArray(raw.files)) return null;
  var origin = self.location.origin;
  for (var i = 0; i < raw.files.length; i++) {
    var f = raw.files[i];
    if (!f || typeof f.url !== 'string' || f.url.charAt(0) !== '/') return null;
    if (typeof f.bytes !== 'number' || !isFinite(f.bytes) || f.bytes < 0) return null;
    try {
      if (new URL(f.url, origin).origin !== origin) return null;
    } catch (e) {
      return null;
    }
  }
  return raw;
}

/** Does any OTHER websynth-* cache hold a completed offline copy? */
function hadOfflineCopy() {
  return caches.keys().then(function (names) {
    var older = names.filter(isOlderAppCache);
    return Promise.all(older.map(function (n) {
      return caches.open(n).then(function (c) { return c.match(OFFLINE_MARKER, MATCH); });
    }));
  }).then(function (hits) {
    return hits.some(Boolean);
  });
}

/** Run `task` over `items`, `limit` at a time; rejects on the first failure. */
function runPool(items, limit, task) {
  var queue = items.slice();
  function next() {
    var item = queue.shift();
    return item === undefined ? Promise.resolve() : task(item).then(next);
  }
  var lanes = [];
  for (var i = 0; i < Math.min(limit, queue.length); i++) lanes.push(next());
  return Promise.all(lanes);
}

/**
 * Refresh a device's offline copy into this version's cache (play-offline.md
 * REQ-the-copy-survives-a-release). An unchanged hashed asset is copied from the older cache instead of
 * refetched — a demo that did not change costs no bandwidth. Any failure
 * rejects, which fails the install: the old worker and its complete cache stay
 * in charge, because `activate` (the purge) never runs.
 */
function refreshOfflineCopy(cache) {
  return fetch(OFFLINE_MANIFEST, { cache: 'no-cache' })
    .then(function (res) {
      if (!res.ok) throw new Error('offline manifest: HTTP ' + res.status);
      return res.json();
    })
    .then(function (raw) {
      var manifest = parseManifest(raw, VERSION);
      if (!manifest) throw new Error('offline manifest: wrong version or shape');
      return runPool(manifest.files, 4, function (file) {
        var old = isHashedAsset(file.url) ? caches.match(file.url, MATCH) : Promise.resolve(undefined);
        return old.then(function (hit) {
          if (hit) return cache.put(file.url, hit);
          return fetch(file.url, { cache: 'no-cache' }).then(function (res) {
            if (!res.ok) throw new Error('offline copy: HTTP ' + res.status + ' for ' + file.url);
            return cache.put(file.url, res);
          });
        });
      }).then(function () {
        var total = 0;
        var urls = manifest.files.map(function (f) { total += f.bytes; return f.url; });
        var marker = { version: VERSION, files: urls, totalBytes: total, completedAt: new Date().toISOString() };
        return cache.put(OFFLINE_MARKER, new Response(JSON.stringify(marker), {
          headers: { 'Content-Type': 'application/json' },
        }));
      });
    });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) {
        return cache.addAll(CORE_ASSETS)
          .then(hadOfflineCopy)
          .then(function (had) { return had ? refreshOfflineCopy(cache) : undefined; });
      })
      .then(function () { return self.skipWaiting(); }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names
          .filter(isOlderAppCache)
          .map(function (n) { return caches.delete(n); }));
      })
      .then(function () { return self.clients.claim(); }),
  );
});

/** Fetch + cache the response when it's cacheable (basic 200s only). */
function fetchAndCache(request) {
  return fetch(request).then(function (response) {
    if (response && response.status === 200 && response.type === 'basic') {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  });
}

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  var strategy = strategyFor(url, event.request.mode, event.request.method, self.location.origin);

  if (strategy === 'passthrough') return;

  if (strategy === 'cache-first') {
    event.respondWith(
      caches.match(event.request, MATCH).then(function (hit) {
        return hit || fetchAndCache(event.request);
      }),
    );
    return;
  }

  // network-first / network-first-nav: fresh when online (never a stale app
  // shell), cached when offline. Navigations fall back to the cached '/'
  // whatever the requested path (SPA: every route serves index.html).
  event.respondWith(
    fetchAndCache(event.request).catch(function () {
      return caches.match(event.request, MATCH).then(function (hit) {
        if (hit) return hit;
        if (strategy === 'network-first-nav') return caches.match('/', MATCH);
        return Promise.reject(new Error('offline: ' + url.pathname));
      });
    }),
  );
});

// Test hook (harmless in production; see file header).
self.__sw = {
  CACHE_PREFIX: CACHE_PREFIX,
  cacheName: cacheName,
  isHashedAsset: isHashedAsset,
  isApiPath: isApiPath,
  strategyFor: strategyFor,
  CORE_ASSETS: CORE_ASSETS,
  OFFLINE_MARKER: OFFLINE_MARKER,
  OFFLINE_MANIFEST: OFFLINE_MANIFEST,
  parseManifest: parseManifest,
  refreshOfflineCopy: refreshOfflineCopy,
};
