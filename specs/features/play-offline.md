# Play offline (save the whole app on the device)

```yaml
id: play-offline
status: implemented
version: 2   # v2: factory reset deletes the copy and it downloads again after the
             #     reload (REQ-the-copy-is-fetched-again-after-a-reset); one notices watcher per copy (REQ-offline-feedback-while-about-is-closed)
owner: Gijs
related:
  - pwa-install          # the service worker this drives (REQ-offline-cancel-and-takeover there)
  - factory-reset        # the About card order this section joins
  - onboarding           # About is the single help door (REQ-20 there)
  - lazy-load-failure    # the gap this closes for a user who opts in
  - runtime-performance  # nothing here runs at boot
  - progress-bar
  - toast
  - typography
  - iconography
  - testids
source:
  - scripts/lib/offline-manifest.mjs
  - vite.config.ts
  - public/sw.js
  - src/utils/offline-copy.ts
  - src/ui/components/about-offline.ts
  - src/ui/components/offline-notices.ts
  - src/state/offline-redownload.ts
  - src/main.ts
  - src/ui/components/about-modal.ts
  - src/ui/components/about-button.ts
  - src/ui/styles/about-offline.module.css
```

`scripts/`, `vite.config.ts` and `public/sw.js` are not SDD-gated paths, but this
spec is their source of truth for everything offline-copy shaped — treat a change
to the manifest plugin or the worker's install-time refresh as a change here.

## Background / Why

The service worker ([pwa-install](pwa-install.md) REQ-service-worker-is-registered) caches only what a visit
actually **fetched**. The build is not one bundle: every demo song is a separate
file fetched on click, and the preset manager, export and record dialogs, the AI
prompt's authoring guide, WiFi pairing, jsQR, time-stretch and the clock worker
are all split chunks. After a normal online session most of that is still absent,
so a user who takes the device somewhere with no connection finds demos that will
not load and dialogs that will not open ([lazy-load-failure](lazy-load-failure.md)).
The idle warm list in `main.ts` covers three chunks by hand and cannot scale to
"everything".

This feature gives the user an explicit **Play offline** button in the About card:
one press downloads every file the app can ever request, with visible progress,
and the copy then keeps itself current across releases. The build writes the
list of files, so nobody maintains it by hand and a new chunk or demo is covered
the day it ships.

## Requirements

- **REQ-the-about-card-hosts-play-offline** (placement) — The About card shows a
  **Play offline** section directly **above Restore to Factory Settings** and
  below the Keyboard Shortcuts grid ([factory-reset](factory-reset.md)
  REQ-about-modal-has-a-reset-button names this as its upper neighbour). The
  section is one wrapper (`play-offline`) holding, in order: a full-width button
  in the card's action style (`switch` root + `Modal.closeBtnClass`, testid
  `play-offline-button`) with a leading drawn icon; a status line
  (`play-offline-status`, `aria-live="polite"`); and a [progress
  bar](progress-bar.md) (`play-offline-progress`) that is shown **only while
  downloading**.

- **REQ-the-build-writes-the-file-list** (the build writes the file list) —
  `vite build` emits `dist/offline-manifest.json` via `offlineManifestPlugin` (a
  `closeBundle` hook that walks the output directory). Every file is listed
  **unless** an exclusion names it, so a newly added public file or chunk is
  included by default. The exclusions, each for a stated reason, are: sourcemaps
  (`*.map`), dotfiles, `_headers` (host config), `robots.txt` and `sitemap.xml`
  (crawlers), `og-card.*` (link unfurlers), `vast-websynth*.png` (install-sheet
  screenshots and README art), `sw.js` (the browser stores the worker script
  itself) and the manifest itself. `index.html` is listed as `/`, the URL the
  worker's navigation fallback reads. Paths are POSIX (the build also runs on
  Windows), sorted, with each file's byte size and the total.

- **REQ-one-offline-state-machine-many-views** (one state machine, many views) —
  `OfflineCopy` (`src/utils/offline-copy.ts`) owns the state; the About section
  only renders it. There is **one instance per page** (`getOfflineCopy()`), so a
  download keeps running after About closes and reopening About shows its live
  progress. The states and what the section shows:

  | State | Button | Status line |
  | --- | --- | --- |
  | `checking` | disabled, **Play offline** | Checking this device… |
  | `none` | **Play offline** | Saves everything on this device — demos, dialogs and help — so it plays with no connection · *N MB* (the *remaining* size, `kB` below a megabyte; omitted when it is unknown or zero) |
  | `downloading` | **Cancel** | Downloading *a* of *b* files · *x* / *y* MB (Preparing… before the list is known) |
  | `complete` | **Ready to play offline** | All *b* files (*y* MB) are on this device. New versions update it automatically. (+ The browser may clear it if storage runs low — when `persisted()` is false) |
  | `error` | **Try again** | worded per reason — see REQ-the-offline-download-runs-in-order/REQ-offline-cancel-and-takeover |
  | `needs-reload` | **Reload** | A new version was installed — reload first. |
  | `unsupported` | disabled, **Play offline** | dev server: Offline play comes with the published app, not the dev server. · otherwise: This browser can't keep an offline copy (a private window can't). |

  Icons: `download` for Play offline, `close` for Cancel, `check` for Ready,
  `reset` for Try again / Reload. Digits in the status line are `tabular-nums`
  ([typography](typography.md) REQ-mono-is-readouts-and-pasted-text); the line is coloured ok in `complete` and
  bad in `error`. The section is **never hidden**: an unavailable feature explains
  itself in the help door rather than vanishing from it.

- **REQ-offline-state-is-checked-when-about-opens** (checked when About opens,
  never at boot) — `refresh()` runs on every About open, not at boot
  ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request). It resolves to:
  - `unsupported` — `enabled` is false (the dev server: the worker is
    production-only) or the browser lacks `serviceWorker` or `caches`;
  - `needs-reload` — a registration exists whose active worker's `?v=` is not
    this page's version and no worker of this page's version is installing or
    waiting;
  - `complete` — the current cache (`websynth-<version>`) holds a **marker** for
    this version and every URL the marker lists;
  - `none` — anything else, with `remainingBytes` computed from the manifest's
    files the cache does not hold, or `null` sizes when the manifest cannot be
    fetched.

  A `refresh()` while downloading changes nothing.

- **REQ-the-offline-download-runs-in-order** (the download) — `start()` does, in
  order: 1. calls `navigator.storage.persist()` **synchronously inside the
  click** and never awaits it — Firefox answers it with a permission prompt, and
  the download must not wait on the user's answer; 2. waits for this page's
  worker: it polls the registration until the active worker's version matches,
  keeps waiting while a worker of this version is installing or waiting (the
  install may itself be downloading), and otherwise gives up after
  `readyTimeoutMs` (15 s) — `needs-reload` if another version is active, `error:
  worker` if there is no registration at all; 3. fetches
  `/offline-manifest.json` (`cache: 'no-cache'`) and validates it
  (REQ-the-manifest-is-same-origin-build-output) — `error: offline` if it
  cannot; 4. compares the remaining bytes to `storage.estimate()`'s free quota —
  `error: storage` if they do not fit; 5. downloads with **four** concurrent
  fetches: a URL already in the cache is skipped, the rest are fetched `cache:
  'no-cache'` with an abort signal, must be `ok`, and are `put` into
  `websynth-<version>`. Progress counts the manifest's **declared** bytes, so
  the total is fixed before the first byte and only ever moves forward; 6.
  writes the marker **only when every file succeeded**, then resolves to
  `complete`.

  A failed file does not stop the others: the ones that succeeded stay cached
  (a retry skips them) and the state becomes `error: files` with the count. A
  `QuotaExceededError` from `put` is `error: storage`. Wording:

  | Reason | Status line |
  | --- | --- |
  | `files` | Couldn't download *n* file(s) — check your connection. The rest is saved. |
  | `offline` | Couldn't reach the server — check your connection and try again. |
  | `storage` | Not enough free storage on this device. |
  | `worker` | The offline helper didn't start — reload the page and try again. |

  Pressing the button in `complete` runs `start()` again: everything is skipped,
  anything the browser evicted is re-fetched, and the marker is rewritten.

- **REQ-offline-cancel-and-takeover** (cancel and takeover) — `cancel()` aborts
  the in-flight fetches and re-reads the device as `refresh()` would, landing on
  `none` with the true remaining size. A `controllerchange` to a worker of
  **another** version during a download means a new release took over (and its
  `activate` purges this version's cache), so the download aborts to
  `needs-reload`. A `controllerchange` to this page's own version — the first
  visit's `clients.claim()` — is ignored.

- **REQ-the-copy-survives-a-release** (the copy survives a release) — A new
  worker's `install`, after precaching `CORE_ASSETS`, looks for the marker in
  any **other** `websynth-*` cache. If one exists, the device had a complete
  offline copy, and the install refreshes it: it fetches the manifest
  (`no-cache`, which must carry the worker's own version), copies each hashed
  `/assets/*` file an older cache already holds (an unchanged demo costs no
  bandwidth), fetches every other file, and writes a new marker. **Any failure
  rejects the install.** The old worker and its complete cache stay in charge —
  `activate`, which purges old caches, never runs — and the browser retries the
  update later. An offline copy is replaced whole or not at all; it never
  silently shrinks back to "what the user happened to open".

- **REQ-offline-feedback-while-about-is-closed** (feedback while About is
  closed) — When a download ends while the About card is hidden, a
  [toast](toast.md) (`play-offline-toast`) reports it: `Ready to play offline.`
  on `complete`; `Offline download stopped — <reason>.` with a **Retry** action
  on `error`; `A new version was installed — reload to save it offline.` with a
  **Reload** action on `needs-reload`. While About is open the status line is
  the report and no toast is raised. A user cancel raises nothing. (v2) The
  toasts are one **watcher per `OfflineCopy`** (`watchOfflineRuns`, in
  `offline-notices.ts`), not the section's: a run can now start with no About
  card built at all (REQ-the-copy-is-fetched-again-after-a-reset). The section
  only tells the watcher whether its inline view is showing, so a run is
  reported exactly once, by whichever of the two the user can see.

- **REQ-the-manifest-is-same-origin-build-output** (trust) — The manifest is
  same-origin build output, as trusted as the JS bundle that fetches it, so it
  takes no entry in `limits.ts` ([untrusted-input](untrusted-input.md) governs
  payloads *other people* author). It is still validated for shape on both
  sides: `version` must equal the reader's own version, and every `url` must be
  root-relative (`/…`, never `//…`) with a finite, non-negative `bytes`, so a
  malformed file cannot point a fetch at another origin.

- **REQ-one-offline-marker-contract** (one marker contract) — The marker is a
  JSON response cached at `/__offline-copy` inside the version's cache. The page
  (`OFFLINE_MARKER_URL`) and the worker (`OFFLINE_MARKER`) spell it separately —
  `sw.js` is plain JS outside the bundle — and a test pins the two equal, as it
  pins `offlineCacheName` to the worker's `cacheName`.

- **REQ-cache-lookups-ignore-vary** (lookups ignore `Vary`, regression) — Every
  cache lookup — the worker's cache-first and offline fallbacks, its release
  refresh, and the page's "is this file saved" checks — passes `{ ignoreVary:
  true }`. A cache honours a stored response's `Vary` header by comparing
  *request* headers, and hosts add `Vary: Origin` to static files (`vite
  preview` does, as does any host with CORS switched on). A module `<script>` or
  `import()` request carries `Origin`; the page's `fetch()` that saved the file
  did not. So the copy was in the cache and **never matched**: the first
  real-browser pass downloaded all 66 files, went offline, and the reload failed
  on its very first chunk. The app's files are content-addressed or
  version-scoped and never differ by request header, so ignoring `Vary` loses
  nothing.

- **REQ-the-copy-is-fetched-again-after-a-reset** (downloaded again after a
  factory reset, v2) — Restore to Factory Settings deletes the offline copy and,
  when a complete one existed, leaves one intent behind: `sessionStorage`
  `websynth.offline.redownload` ([factory-reset](factory-reset.md)
  REQ-reset-redownloads-the-offline-copy/REQ-reset-never-strands-an-offline-device).
  After the reload, boot reads that key (one `sessionStorage` read — the whole
  boot cost, and no work at all without it) and, on idle, lazy-loads
  `offline-notices.ts`, whose `resumeOfflineRedownload()` **consumes** the
  intent, raises `Downloading the offline copy again…` (`play-offline-toast`)
  and runs `start()`. The run ends like any other
  (REQ-offline-feedback-while-about-is-closed). Consuming before starting is
  deliberate: a reload mid-download must not restart it forever, and About still
  shows what is left.

## Technical design

### Contract / public interface

```yaml
# scripts/lib/offline-manifest.mjs  (build time, Node)
OFFLINE_MANIFEST_FILE: "offline-manifest.json"
isOfflineExcluded(path: string): boolean              # POSIX path relative to outDir
buildOfflineManifest(entries: {path, bytes}[], version): OfflineManifest
offlineManifestPlugin(version): VitePlugin             # apply: build, closeBundle;
                                                       # walks outDir with zip.mjs listFiles

# src/utils/offline-copy.ts  (page)
OFFLINE_MARKER_URL: "/__offline-copy"
OFFLINE_MANIFEST_URL: "/offline-manifest.json"
OFFLINE_CACHE_PREFIX: "websynth-"
offlineCacheName(version): "websynth-<version>"
parseOfflineManifest(raw: unknown, version): OfflineManifest | null
deleteOfflineCopies(caches: CacheStorage): Promise<{ hadCopy: boolean }>
  # deletes every websynth-* cache; hadCopy = one of them held a marker (REQ-the-copy-is-fetched-again-after-a-reset)
class OfflineCopy(deps: OfflineCopyDeps):
  state: OfflineState
  subscribe(fn: (s: OfflineState) => void): () => void   # does not call fn immediately
  refresh(): Promise<void>
  start(): Promise<void>        # resolves when the run ends; a second call joins it
  cancel(): void
getOfflineCopy(): OfflineCopy   # the page's one instance, real globals, enabled = PROD

# src/ui/components/about-offline.ts
offlineView(state: OfflineState): { label, icon, disabled, status, tone: ok|bad|null,
                                    progress: number | indeterminate | null }   # REQ-one-offline-state-machine-many-views's table as data
buildOfflineSection(copy?: OfflineCopy, reload?: () => void): { root: HTMLElement; refresh(): void }

# src/ui/components/offline-notices.ts
watchOfflineRuns(copy, reload): { setInlineView(showing: (() => boolean) | null): void }
  # idempotent per copy — the one subscriber that raises REQ-offline-feedback-while-about-is-closed's toasts
resumeOfflineRedownload(copy?, reload?): boolean   # REQ-the-copy-is-fetched-again-after-a-reset; true when it started a run

# src/state/offline-redownload.ts
OFFLINE_REDOWNLOAD_KEY: "websynth.offline.redownload"   # sessionStorage
requestOfflineRedownload(): void
offlineRedownloadPending(): boolean                      # read-only, for the boot check
takeOfflineRedownload(): boolean                         # read + remove

# public/sw.js
self.__sw += { CACHE_PREFIX, OFFLINE_MARKER, OFFLINE_MANIFEST, parseManifest, refreshOfflineCopy }
```

### Data shapes

```yaml
OfflineManifest:          # dist/offline-manifest.json
  version: string         # package.json version
  files: OfflineFile[]    # sorted by url
  totalBytes: number

OfflineFile:
  url: string             # "/", "/assets/index-abc.js", "/worklets/recorder.js"
  bytes: number

OfflineMarker:            # cached at /__offline-copy in websynth-<version>
  version: string
  files: string[]         # the urls
  totalBytes: number
  completedAt: string     # ISO timestamp

OfflineCopyDeps:
  enabled: boolean        # import.meta.env.PROD
  version: string
  caches?: CacheStorage
  fetch?: typeof fetch
  serviceWorker?: ServiceWorkerContainer
  storage?: StorageManager
  readyTimeoutMs?: number # 15000
  pollMs?: number         # 250
  concurrency?: number    # 4

OfflineState:             # discriminated on `kind`
  unsupported:  { reason: dev | browser }
  checking:     {}
  none:         { totalBytes: number | null, remainingBytes: number | null }
  downloading:  { doneFiles, totalFiles, doneBytes, totalBytes }   # totals 0 = preparing
  complete:     { files, totalBytes, persisted: boolean }
  error:        { reason: files | offline | storage | worker, failed: number }
  needs-reload: {}
```

### Layer touchpoints & ordering

```yaml
vite.config.ts: plugins -> offlineManifestPlugin(pkg.version)
about-modal.ts buildModal: appends the section directly before the factory-reset button
  # the card's full order is written down once, in factory-reset.md "Layer touchpoints"
about-modal.ts: returns refreshOffline
about-button.ts open(): refreshOffline() once per open   # not in the 500 ms debug poll
about-offline.ts: renders the state; subscribes once for the card's lifetime (built once,
                  reused) and hands watchOfflineRuns its "inline view showing" test
offline-notices.ts: the only module that raises play-offline-toast
factory-reset.ts: deleteOfflineCopies() -> requestOfflineRedownload() after the storage clear
main.ts boot idle: offlineRedownloadPending()? -> import(offline-notices).resumeOfflineRedownload()
sw.js install: addAll(CORE_ASSETS) -> hadOfflineCopy() -> refreshOfflineCopy(cache)? -> skipWaiting
```

### Persistence

- CacheStorage `websynth-<version>`: the app files plus the `/__offline-copy`
  marker. Purged with its version by the worker's `activate`
  ([pwa-install](pwa-install.md) REQ-service-worker-is-registered).
- `navigator.storage.persist()` is requested, never required.
- No `localStorage`: "is there an offline copy" is answered by the cache itself,
  so a browser that evicts the cache can never leave a stale flag claiming one.
- `sessionStorage` `websynth.offline.redownload` (v2): the one intent a factory
  reset writes back after wiping everything, consumed on the next boot (REQ-the-copy-is-fetched-again-after-a-reset).
  Session, not local, storage: it must survive exactly that tab's reload and die
  with the tab.

## Gesture inventory (ADR-014)

| Gesture | Target | Outcome | Precedent |
| --- | --- | --- | --- |
| click / tap | button in `none` / `error` | starts the download (REQ-the-offline-download-runs-in-order) | the export dialog's Export |
| click / tap | button in `downloading` | cancels (REQ-offline-cancel-and-takeover) | the export dialog's in-flight Cancel |
| click / tap | button in `complete` | re-checks and repairs the copy | — (decided: a success state that still does something useful beats a dead button) |
| click / tap | button in `needs-reload` | reloads the page | the perf-settings Reload |
| click / tap | disabled button | nothing | `switch.module.css` `:disabled` |
| Enter / Space | focused button | same as click | native `<button>` |
| click / tap | toast Retry / Reload | `start()` / reload | [lazy-load-failure](lazy-load-failure.md) Retry |
| close About | mid-download | the download continues; REQ-offline-feedback-while-about-is-closed reports the end | — (decided: closing a help card is not a cancel) |
| long-press, drag, wheel, right-click | the section | nothing | — |

## Scenarios (BDD)

```gherkin
Scenario: The section sits above Restore to Factory Settings (REQ-the-about-card-hosts-play-offline)
  Given the About modal is open
  Then the play-offline section follows the shortcuts grid
   And the factory-reset button follows the play-offline section
# pinned by: tests/ui/about.test.ts

Scenario: The build lists every file except the named exclusions (REQ-the-build-writes-the-file-list)
  Given an output tree with chunks, demos, worklets, index.html, sourcemaps and crawler files
  When the manifest is built
  Then every chunk, demo and worklet is listed with its size, index.html as "/"
   And no sourcemap, _headers, robots.txt, sitemap.xml, og-card, screenshot or sw.js is listed
   And Windows separators become "/"
# pinned by: tests/scripts/offline-manifest.test.ts

Scenario: Unsupported on the dev server and without the APIs (REQ-one-offline-state-machine-many-views, REQ-offline-state-is-checked-when-about-opens)
  Given enabled is false, or the browser has no caches
  When About opens
  Then the button is disabled and the status line says why
# pinned by: tests/utils/offline-copy.test.ts, tests/ui/about-offline.test.ts

Scenario: About opening reports the remaining size (REQ-offline-state-is-checked-when-about-opens)
  Given two of three manifest files are already cached and there is no marker
  When refresh runs
  Then the state is none with the third file's size remaining
# pinned by: tests/utils/offline-copy.test.ts

Scenario: A complete copy is recognised (REQ-offline-state-is-checked-when-about-opens)
  Given the cache holds this version's marker and every file it lists
  When refresh runs
  Then the state is complete
# pinned by: tests/utils/offline-copy.test.ts

Scenario: Downloading fills the cache, reports progress, then writes the marker (REQ-the-offline-download-runs-in-order)
  Given no offline copy and a reachable server
  When the user presses Play offline
  Then persist() is requested without being awaited
   And each uncached file is fetched and cached, cached ones are skipped
   And the progress only moves forward and ends at the declared total
   And the marker is written and the state is complete
# pinned by: tests/utils/offline-copy.test.ts

Scenario: A failed file keeps the rest and writes no marker (REQ-the-offline-download-runs-in-order)
  Given one manifest file answers 404
  When the download runs
  Then the other files are cached, no marker is written
   And the state is error "files" with one failure
# pinned by: tests/utils/offline-copy.test.ts

Scenario: Not enough storage stops before downloading (REQ-the-offline-download-runs-in-order)
  Given storage.estimate() reports less free quota than the remaining bytes
  When the download starts
  Then nothing is fetched and the state is error "storage"
# pinned by: tests/utils/offline-copy.test.ts

Scenario: Another version's worker blocks the download (REQ-the-offline-download-runs-in-order, REQ-offline-cancel-and-takeover)
  Given the active worker is a different version and none of this version is installing
  When the download starts
  Then the state is needs-reload
# pinned by: tests/utils/offline-copy.test.ts

Scenario: Cancel returns to none (REQ-offline-cancel-and-takeover)
  Given a download in flight
  When the user presses Cancel
  Then the fetches are aborted and the state is none with the true remaining size
# pinned by: tests/utils/offline-copy.test.ts

Scenario: A new version taking over mid-download (REQ-offline-cancel-and-takeover)
  Given a download in flight
  When controllerchange fires for a worker of another version
  Then the download aborts and the state is needs-reload
# pinned by: tests/utils/offline-copy.test.ts

Scenario: A release refreshes the offline copy at install (REQ-the-copy-survives-a-release)
  Given an older websynth cache holds the marker and a hashed demo
  When the new worker installs
  Then the demo is copied from the old cache without a fetch
   And every other listed file is fetched into the new cache, followed by a new marker
# pinned by: tests/pwa/sw.test.ts

Scenario: Without an offline copy the install stays core-only (REQ-the-copy-survives-a-release)
  Given no cache holds the marker
  When the new worker installs
  Then only CORE_ASSETS are cached and the manifest is never fetched
# pinned by: tests/pwa/sw.test.ts

Scenario: A failed refresh keeps the old copy in charge (REQ-the-copy-survives-a-release, failure)
  Given an older cache holds the marker
  When the manifest has the wrong version, or a listed file fails
  Then the install rejects and skipWaiting is not called
# pinned by: tests/pwa/sw.test.ts

Scenario: Page and worker agree on the marker and cache name (REQ-one-offline-marker-contract)
  Given public/sw.js loaded under stubbed globals
  Then OFFLINE_MARKER equals OFFLINE_MARKER_URL
   And cacheName("…/sw.js?v=X") equals offlineCacheName("X")
# pinned by: tests/pwa/sw.test.ts

Scenario: A file saved by the page matches a script request despite Vary (REQ-cache-lookups-ignore-vary, regression)
  Given a cached hashed asset whose response carries "Vary: Origin"
  When the page requests it offline, as a module script would, with an Origin header
  Then the worker serves it from the cache
   And the page's own check counts a Vary-carrying entry as saved
# pinned by: tests/pwa/sw.test.ts, tests/utils/offline-copy.test.ts

Scenario: A factory reset's intent downloads the copy again after the reload (REQ-the-copy-is-fetched-again-after-a-reset)
  Given sessionStorage holds websynth.offline.redownload
  When resumeOfflineRedownload runs
  Then the intent is removed before the run starts
   And play-offline-toast says the offline copy is downloading again
   And start() runs, and its end is reported like any other run
# pinned by: tests/ui/offline-notices.test.ts

Scenario: Without an intent, boot downloads nothing (REQ-the-copy-is-fetched-again-after-a-reset)
  Given no websynth.offline.redownload
  When resumeOfflineRedownload runs
  Then start() is not called and no toast is raised
# pinned by: tests/ui/offline-notices.test.ts

Scenario: One run is announced once, whoever is watching (REQ-offline-feedback-while-about-is-closed, v2)
  Given the resumed run's watcher and an About section on the same copy
  When the run completes with the card hidden
  Then exactly one completion toast is raised
# pinned by: tests/ui/offline-notices.test.ts

Scenario: Deleting reports whether a complete copy existed (REQ-the-copy-is-fetched-again-after-a-reset)
  Given websynth-1.0.0 holds the marker and a foreign cache exists
  When deleteOfflineCopies runs
  Then every websynth-* cache is gone, the foreign cache is kept, and hadCopy is true
# pinned by: tests/utils/offline-copy.test.ts

Scenario: The section renders each state (REQ-one-offline-state-machine-many-views)
  Given a stub OfflineCopy
  When it emits none, downloading, complete, error and needs-reload
  Then the button label, its disabled state, the status line and the bar's visibility follow the table
# pinned by: tests/ui/about-offline.test.ts

Scenario: A download that ends behind a closed About raises a toast (REQ-offline-feedback-while-about-is-closed)
  Given a download started from About and the card is now hidden
  When the state becomes complete, or error
  Then play-offline-toast reports it, with Retry on error
   And no toast is raised while the card is visible
# pinned by: tests/ui/about-offline.test.ts
```

## Tests & verification

- Unit: `tests/scripts/offline-manifest.test.ts`, `tests/utils/offline-copy.test.ts`
  (fake CacheStorage, fetch and ServiceWorkerContainer), `tests/pwa/sw.test.ts`,
  `tests/ui/about-offline.test.ts`, `tests/ui/offline-notices.test.ts`,
  `tests/state/factory-reset.test.ts`, `tests/ui/about.test.ts` — `npm test`.
  The fakes are shared (`tests/fixtures/offline-fakes.ts`), and so is the manifest
  validation table both parsers run (`tests/fixtures/offline-manifest-cases.ts`).
- Typecheck: `npm run typecheck`
- Build: `npm run build`, then check `dist/offline-manifest.json` lists every lazy
  chunk and demo (diff against `find dist -type f` minus the REQ-the-build-writes-the-file-list exclusions).
- Real browser (manual or a scratch Playwright script against `vite preview`):
  About → Play offline → Ready; go offline; reload; the app boots, a never-opened
  dialog opens, and a never-clicked JSON and zip demo load.
- Release refresh: build version N, save offline, rebuild as N+1, reload online —
  the new worker installs with the full copy; offline reload runs N+1.
- Firefox by hand: the persist prompt, the private-window unsupported line.

End-to-end runs in Chromium against `vite preview` (not committed, because
Playwright's `webServer` is the dev server, which never registers the worker),
2026-09-14:
- **Download and offline boot:** every listed file (5.5 MB) saved with live
  progress; offline, the app booted, every file was served, the preset manager,
  export and WiFi-pair dialogs opened, and a never-clicked JSON and zip demo
  loaded. This pass found REQ-cache-lookups-ignore-vary.
- **Release refresh:** a second build as the next version, on the same origin,
  refreshed the copy at install — only the changed hashed chunks were fetched,
  the rest copied, the old cache purged — and the offline boot ran the new version.
- **Factory reset (v2):** online, a cache entry planted before the reset was gone
  afterwards, the copy downloaded again on its own (both toasts shown), About read
  Ready and the intent was consumed; offline, the confirm said the copy is kept,
  the planted entry survived, and the app rebooted from it.

Firefox has not been run.

## Gotchas

- **`Vary` hides saved files** (REQ-cache-lookups-ignore-vary). Any new `match` against these caches
  passes `{ ignoreVary: true }`. The unit fakes model it — a stored entry marked
  as varying misses without the flag — so a forgotten option fails a test.
- **The cache prefix is spelled twice** — `OFFLINE_CACHE_PREFIX` here and
  `CACHE_PREFIX` in `sw.js` — and a factory reset deletes by it. The worker test
  pins them equal, so a renamed cache cannot outlive a reset.
- **A detached `fetch` throws "Illegal invocation"** in browsers. `getOfflineCopy`
  passes a wrapper; a test double that is a plain function cannot catch this.
- **`npm run e2e` cannot exercise any of this**: it drives the dev server, where
  the section correctly reports itself unsupported. Verifying a change here means
  `npm run build` and a browser against `vite preview` (see Tests & verification).
- A Playwright `waitForFunction` given an **async** predicate resolves at once (a
  promise is truthy); poll cache state from the test side instead.

## Open questions / future

- The debug panel's service-worker row could also report the offline copy's state.
- The [lazy-load-failure](lazy-load-failure.md) offline wording could point at
  this button ("…save it with Play offline next time you're online").
