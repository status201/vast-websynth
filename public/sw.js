/**
 * Offline service worker — hand-written, dependency-free (ADR-003 discipline;
 * spec: specs/features/pwa-install.md REQ-6).
 *
 * Registered PRODUCTION-ONLY from main.ts as `/sw.js?v=<app version>` — the
 * version query names the cache (`websynth-<version>`) and makes each release
 * a byte-different registration URL, so browsers re-fetch and install the new
 * worker. NEVER register this on the dev server: it will poison Vite HMR
 * (unregister via DevTools → Application → Service Workers if you did).
 *
 * Strategy (see `strategyFor`):
 *   - non-GET / cross-origin        → passthrough (not intercepted)
 *   - /assets/* (hashed, immutable) → cache-first, miss-fill
 *   - navigations                   → network-first, fallback to cached '/'
 *   - other same-origin GETs        → network-first, cache on success
 *
 * Runtime caching only — no precache manifest of hashed assets. The app is
 * one eager bundle, so a single online visit *after* this worker controls the
 * page caches everything: offline-ready after the first revisit/reload.
 *
 * Pure decision helpers are exposed on `self.__sw` so the Vitest suite
 * (tests/pwa/sw.test.ts) can import this file with stubbed globals — the
 * same pattern as the compressor worklet's unit tests.
 */
'use strict';

/** Cache name for a given registration URL (the `?v=` query names it). */
function cacheName(swUrl) {
  var v = new URL(swUrl).searchParams.get('v') || 'dev';
  return 'websynth-' + v;
}

/** Hashed Vite build output — immutable, safe to serve from cache forever. */
function isHashedAsset(pathname) {
  return pathname.indexOf('/assets/') === 0;
}

/**
 * Classify a request. `passthrough` requests are never intercepted; the rest
 * map to the handlers below.
 */
function strategyFor(url, mode, method, origin) {
  if (method !== 'GET' || url.origin !== origin) return 'passthrough';
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

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(CORE_ASSETS); })
      .then(function () { return self.skipWaiting(); }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names
          .filter(function (n) { return n.indexOf('websynth-') === 0 && n !== CACHE; })
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
      caches.match(event.request).then(function (hit) {
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
      return caches.match(event.request).then(function (hit) {
        if (hit) return hit;
        if (strategy === 'network-first-nav') return caches.match('/');
        return Promise.reject(new Error('offline: ' + url.pathname));
      });
    }),
  );
});

// Test hook (harmless in production; see file header).
self.__sw = {
  cacheName: cacheName,
  isHashedAsset: isHashedAsset,
  strategyFor: strategyFor,
  CORE_ASSETS: CORE_ASSETS,
};
