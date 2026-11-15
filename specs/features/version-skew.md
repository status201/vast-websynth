# Version skew (an old tab after a deploy)

```yaml
id: version-skew
status: implemented
version: 1
owner: core
related:
  - lazy-load-failure   # REQ-one-wording-for-lazy-failure — the toast this refines when the cause is a newer release
  - pwa-install         # REQ-service-worker-is-registered — the worker whose activate purges the old cache
  - play-offline        # REQ-the-build-writes-the-file-list — the manifest the probe reads
  - song-mode           # REQ-drop-in-demos-are-fetched-on-click — the demo fetch that can 404
  - session-autosave    # why Reload is safe
  - toast
source:
  - src/utils/live-version.ts                # the probe + the takeover watch
  - src/ui/components/version-skew-toast.ts  # the two toasts
  - src/ui/offline-wording.ts                # the shared clauses
  - src/ui/components/lazy-load-toast.ts     # consumer: a failed surface import
  - src/ui/panels/song-panel.ts              # consumer: a failed demo load
  - src/main.ts                              # wires the takeover watch
```

## Background / Why

A deploy replaces `dist/assets/`. A tab still running the previous release keeps
working on what it already loaded. But anything it fetches *later* names a
hashed file of its own release: a demo song (fetched on click), a deferred dialog
or DSP module (behind `import()`). Unchanged files come back under the same
hashed name, so most of them survive the deploy. A file whose content changed,
or one that was removed, is gone, and the fetch 404s.

The service worker cannot cover this. It caches only what the tab fetched
([pwa-install](pwa-install.md) REQ-service-worker-is-registered), and opening the
new release anywhere installs a worker that claims every tab and deletes the old
cache in `activate`. Before this spec, the user saw `Couldn't open … — the
download failed.` with a **Retry** that could never succeed, or a "Demo failed
to load: fetch failed (404)" dialog. The real remedy is a reload, and nothing
said so.

## Requirements

- **REQ-a-failure-asks-whether-a-newer-version-is-live** — When a deferred load
  fails **while online**, the app asks the server which version it serves
  *before* reporting the failure. A deferred load here is a surface's
  `import()` ([lazy-load-failure](lazy-load-failure.md)
  REQ-every-lazy-trigger-reports) or a demo's fetch/parse. "Online" means
  `navigator.onLine !== false`. The question is a fetch of
  `OFFLINE_MANIFEST_URL` (`/offline-manifest.json`). The build already writes
  this file with its `version`, it keeps its name across releases, and it is
  served `no-cache` (DEPLOYMENT.md "Caching"). It is fetched with
  `cache: 'no-store'`, and **only after a failure**: a session in which nothing
  fails never makes the request. Offline, nothing is asked; the offline wording
  stays as it is and stays synchronous.

- **REQ-the-version-probe-is-bounded** — `liveVersion()` resolves the server's
  version or `null`, and **never rejects**. It returns `null` for: a network
  error, a non-2xx response, a body that is not JSON (the `index.html` that a
  host's SPA fallback or `vite dev` returns), a `version` that is not a string
  of 1–`MAX_VERSION_CHARS` (32, in `src/state/limits.ts`) characters, or a
  request still unanswered after `VERSION_PROBE_TIMEOUT_MS` (3 s, then aborted).
  A failure report waits on the probe, so a captive portal that never answers
  must not hold it back. `null` means "unknown", and the caller falls back to
  today's report. The manifest is same-origin build output, read the way
  [play-offline](play-offline.md) already reads it. Only the one string is kept,
  and only to compare it with `__APP_VERSION__`.

- **REQ-a-stale-failure-offers-reload** — When the server's version is **later**
  than `__APP_VERSION__` (`isNewerVersion`: dotted numbers compare numerically;
  any other shape compares by inequality), the failure is reported as version
  skew instead of as a failed download. A rollback to an earlier version is not
  "newer", and keeps today's report. The report is a [toast](toast.md) with a **Reload** action
  (`location.reload()`), not Retry: retrying the same old URL cannot work.
  testid `version-skew-toast`. The wording comes from
  `src/ui/offline-wording.ts`, so the surfaces cannot drift:

  | where | message |
  | --- | --- |
  | a surface's `import()` | `Couldn't open <surface> — a newer version of VAST is out. Reload to get it.` |
  | a demo | `Couldn't load "<name>" — a newer version of VAST is out. Reload to get it.` |

  The demo path shows this toast *instead of* its failure dialog, for every
  failure between the fetch and the parse. That includes a 200 whose body is
  the host's HTML fallback, which fails validation rather than the fetch. A
  failure *applying* a song that did arrive is never skew, so it keeps its
  copyable dialog.
  **Reload is safe**: a pending autosave is flushed on `pagehide`, and the
  tab's session key survives its own reload
  ([session-autosave](session-autosave.md) REQ-a-pending-save-flushes-on-unload,
  REQ-each-tab-autosaves-to-its-own-key).

- **REQ-a-takeover-by-a-newer-worker-is-announced** — In production, when this
  tab's service-worker controller changes to a worker whose registration URL's
  `?v=` (`workerVersion`) is a later release than `__APP_VERSION__`, the tab
  shows a **sticky** toast (`durationMs: 0`): `A newer version of VAST is running in
  another tab — reload to switch to it.` with **Reload**, testid
  `version-skew-takeover-toast`. This happens when the new release has opened
  elsewhere and its worker has claimed this tab and purged its cache, which is
  exactly when the tab's later fetches start to fail. It fires **at most once**
  per page. It does not fire for a first install (same version, or no `?v`), for
  a controller that goes away (`null`), or for an older release's worker (the
  sentence says "newer"). It is announced, not acted on: the user may be
  mid-performance, so nothing reloads by itself. Like any toast it is replaced
  by the next one ([toast](toast.md)), which is why it also confirms the skew
  for REQ-a-confirmed-skew-is-remembered. `watchForTakeover` itself fires on *any*
  other version, because any takeover purges this version's cache; Play offline
  stops its download on it too ([play-offline](play-offline.md)
  REQ-offline-cancel-and-takeover).

- **REQ-a-confirmed-skew-is-remembered** — Once a newer release has been seen,
  by a probe or a takeover, it stays live for the rest of the page, because
  nothing reloads behind the user's back. Every later failure is reported as skew
  without asking the server again, and the takeover toast being replaced by
  another toast does not lose the warning. The memo is module state in
  `version-skew-toast.ts`, and a reload clears it.

- **REQ-a-deploy-keeps-the-previous-assets** — Detection is the backstop.
  Prevention is in the deploy: **copy the new `dist/` over the old one instead
  of emptying `assets/` first**, and prune files older than the previous release
  only afterwards. Hashed names never collide, so leftovers cost only disk.
  Written in DEPLOYMENT.md "Caching"; nothing in the app can enforce it.

## Technical design

### Contract / public interface

```ts
// src/utils/live-version.ts — leaf: imports only the constants in state/limits.ts
export const OFFLINE_MANIFEST_URL = '/offline-manifest.json'; // re-exported by offline-copy.ts
export const VERSION_PROBE_TIMEOUT_MS = 3000;
export function workerVersion(worker: ServiceWorker | null | undefined): string | null; // ?v= of scriptURL
export function isNewerVersion(live: string, ours: string): boolean;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export function liveVersion(fetchFn?: FetchFn, timeoutMs?: number): Promise<string | null>;
export function newerVersionLive(fetchFn?: FetchFn, ours?: string): Promise<boolean>;
export function watchForTakeover(sw: ServiceWorkerContainer, onTakeover: (version: string) => void, ours?: string): () => void;

// src/ui/components/version-skew-toast.ts
export function showNewerVersionToast(lead: string): void;        // lead = "Couldn't open the demo library"
export function reportIfNewerVersion(lead: string): Promise<boolean>; // memo, else probe; true = skew, toast is up
export function onTakeover(version: string, ours?: string): void;  // announces only a newer version
```

`ours` defaults to `__APP_VERSION__`, `fetchFn` to the global `fetch` and
`timeoutMs` to `VERSION_PROBE_TIMEOUT_MS`; they are parameters only so tests can
supply their own. The wording, including the
takeover sentence (`TAKEOVER_NOTICE`) and the action label (`RELOAD_LABEL`), lives
in `src/ui/offline-wording.ts` beside `NEWER_VERSION_LIVE` and `RELOAD_TO_GET_IT`.

### Layer touchpoints & ordering

- `live-version.ts` owns `OFFLINE_MANIFEST_URL`, `workerVersion` and
  `watchForTakeover`, which `offline-copy.ts` imports from it. There is one
  spelling of each, and so one rule for what counts as a takeover. The entry
  chunk reaches the probe without pulling in the offline-copy state machine.
- `lazy-load-toast.ts` keeps its signature and its offline branch. Online, it
  awaits `reportIfNewerVersion` and shows the old failed-download toast only on
  `false`. Its import list grows by the leaf toast module alone (still no
  boot-path weight, per lazy-load-failure.md's layer note).
- `song-panel.ts`: `loadJsonDemo` / `loadZipDemo` route every fetch-or-parse
  failure through one helper that asks `reportIfNewerVersion` first, and keep a
  separate catch around the apply.
- `main.ts` calls `watchForTakeover(…, onTakeover)` beside the worker
  registration, under the same `import.meta.env.PROD` guard.
- Overlap with [play-offline](play-offline.md)'s own takeover notice (a download
  interrupted by a new worker) is fine: toasts replace, not stack, and both
  offer Reload.

### Persistence

None. The confirmed-skew memo (REQ-a-confirmed-skew-is-remembered) is module
state and ends with the page. The takeover's once-per-page flag is the listener
removing itself.

## Scenarios (BDD)

```gherkin
Scenario: the probe reads the server's version (REQ-the-version-probe-is-bounded)
  Given /offline-manifest.json answers {"version":"9.9.9","files":[]}
  When liveVersion() runs
  Then it resolves "9.9.9" and the request used cache: 'no-store'
# pinned by: tests/utils/live-version.test.ts

Scenario: anything else is unknown, never a throw (REQ-the-version-probe-is-bounded)
  Given the manifest request rejects, answers 404, answers HTML,
    answers JSON without a string version, or a version over 32 characters
  When liveVersion() runs
  Then it resolves null
# pinned by: tests/utils/live-version.test.ts

Scenario: a request that hangs is given up on (REQ-the-version-probe-is-bounded)
  Given the manifest request never answers
  When liveVersion() runs with its timeout
  Then it aborts the request and resolves null
# pinned by: tests/utils/live-version.test.ts

Scenario: a rollback is not newer (REQ-a-stale-failure-offers-reload)
  Given ours is 1.4.0 and the server serves 1.3.9
  Then newerVersionLive() is false, and isNewerVersion compares 2.10.0 above 2.9.1
# pinned by: tests/utils/live-version.test.ts

Scenario: a surface that fails under a newer release offers Reload (REQ-a-stale-failure-offers-reload)
  Given the browser is online and the server serves a newer version
  When a surface's import rejects
  Then a version-skew-toast names the surface, says a newer version is out, and offers Reload
  And no lazy-load-failed-toast is shown
# pinned by: tests/ui/version-skew.test.ts

Scenario: same, older or unknown version keeps today's report (REQ-a-failure-asks-whether-a-newer-version-is-live)
  Given the browser is online and the probe resolves our own version, an older one, or null
  When a surface's import rejects
  Then the lazy-load-failed-toast says "the download failed" and offers Retry
# pinned by: tests/ui/version-skew.test.ts, tests/ui/lazy-load-failure.test.ts

Scenario: offline asks nothing (REQ-a-failure-asks-whether-a-newer-version-is-live)
  Given navigator.onLine is false
  When a surface's import rejects
  Then the offline toast shows and the manifest is never fetched
# pinned by: tests/ui/version-skew.test.ts

Scenario: a demo that fails under a newer release offers Reload (REQ-a-stale-failure-offers-reload)
  Given the server serves a newer version
  When a demo's fetch fails or its body does not parse
  Then the version-skew-toast names the demo and no failure dialog opens
  But a failure applying a demo that arrived keeps its dialog
# pinned by: tests/ui/version-skew.test.ts (the demo-panel source is checked structurally)

Scenario: a confirmed skew is asked once (REQ-a-confirmed-skew-is-remembered)
  Given one failure has confirmed a newer release, or a newer worker took over
  When another deferred load fails
  Then the version-skew-toast shows without a second manifest request
# pinned by: tests/ui/version-skew.test.ts

Scenario: a newer worker taking over is announced once (REQ-a-takeover-by-a-newer-worker-is-announced)
  Given watchForTakeover is listening with our version "1.0.0"
  When the controller changes to /sw.js?v=1.0.1, and then again
  Then onTakeover is called exactly once, with "1.0.1"
  When instead the controller changes to /sw.js?v=1.0.0, or to null
  Then onTakeover is not called
# pinned by: tests/utils/live-version.test.ts

Scenario: the takeover toast stays until dismissed (REQ-a-takeover-by-a-newer-worker-is-announced)
  When onTakeover() runs with a newer version
  Then a version-skew-takeover-toast with a Reload action is shown and does not time out
  When it runs with an older version instead
  Then no toast is shown
# pinned by: tests/ui/version-skew.test.ts
```

## Tests & verification

- Unit: `tests/utils/live-version.test.ts` (node: the probe, `workerVersion`, the
  takeover watch with a fake `ServiceWorkerContainer`) and
  `tests/ui/version-skew.test.ts` (jsdom: the toasts, the lazy-load branch) —
  `npm test`.
- Typecheck: `npm run typecheck`.
- Boot payload: `npm run build && npm run check:bundle`. The entry chunk grows
  only by the leaf modules, and no lazy chunk grows.
- **By hand** (`npm run build && npx vite preview`, Firefox then Chrome). Load
  and reload so the worker controls the tab. Then edit
  `dist/offline-manifest.json`'s `version`, delete
  `dist/assets/demo-library-*.js` and one demo's JSON, and open the demo
  library and that demo: each shows the version-skew toast, and Reload restores
  the session. Restore the manifest's version and repeat: the old wording comes
  back. For the takeover, rebuild with a bumped version and open a second tab:
  the first tab shows the takeover toast.

## Open questions / future

- The online failure report now waits for the probe (bounded by
  `VERSION_PROBE_TIMEOUT_MS`, usually one same-origin round trip). A toast raised
  in that window is replaced when the report lands, as toasts always replace. A
  report that never replaces would break lazy-load-failure.md
  REQ-every-lazy-trigger-reports, so the window is kept short instead of closed.
- One hook for every chunk failure (Vite's `vite:preloadError`, or an `import()`
  wrapper) would cover the quiet imports too. It is not used: demos are not
  imports, and the quiet imports are quiet by design (below).

- The quiet in-operation imports (the flanger DSP, the delay/dirt types, sync
  roles) still fail quietly, per lazy-load-failure.md
  REQ-lazy-scope-is-surfaces-not-operations. The takeover toast is their cover.
  Probing on each of them would put a toast on a gesture that never asked to
  open anything.
