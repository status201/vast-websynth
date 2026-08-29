# Debug panel

```yaml
id: debug-panel
status: implemented
version: 11  # v11: the ctx-state row also names the autoplay verdict — the one
             #      glance that says whether a start modal was shown at all, and
             #      why a boot could be audible (audio-lifecycle.md v6 REQ-19/20)
             # v10: the Suspend action goes through Engine.suspendForDebug() so the
             #      universal statechange re-arm can tell a deliberate suspend from
             #      an OS one, and the ctx-state row shows when a resume is waiting
             #      for a gesture (audio-lifecycle.md v5 REQ-13/REQ-15)
             # v9: about.ts split five ways — the panel is now about-debug.ts,
             #     the late-bound row sources are state/debug-sources.ts, and
             #     createAboutButton is about-button.ts (runtime-performance REQ-1)
             # v8: createAboutButton takes the tour hook too, and the section
             #     header class is now the shared `.secFold` (onboarding.md v15)
             # v7: + the Background audio row (audio-lifecycle.md REQ-12)
             # v6: + the Media session row (media-session.md REQ-8); v5 put
             #     Clock.dropouts on the Transport row (audio-lifecycle REQ-7)
owner: core
related:
  - architecture
  - ios-audio
  - audio-lifecycle
  - media-session
  - transport
  - performance-mode
  - sample-persistence
  - session-autosave
  - pwa-install
  - dialog
  - runtime-performance             # REQ-1 — why the panel is behind a lazy import
source:
  - src/ui/components/about-debug.ts # the panel itself
  - src/ui/components/about-button.ts # createAboutButton + the open/close lifecycle
  - src/ui/components/about-modal.ts # builds the card the panel sits in
  - src/state/debug-sources.ts       # the late-bound row sources (REQ-4)
  - src/state/session-autosave.ts    # SessionAutosave.stats
  - src/state/slot-store.ts          # storageUsage
  - src/utils/wake-lock.ts           # WakeLockManager.held
  - src/audio/transport/clock.ts     # Clock.bpm
  - src/audio/midi.ts                # initMIDI resolves the access handle
```

A small, **reusable** diagnostics panel inside the About modal: a default-collapsed
"Debug" section that renders a live key/value list of runtime state — and, since
v3, the **actions** that act on it. Features contribute their own rows — it is
intentionally generic and extensible, not tied to any one feature.

## Background / Why

Some runtime state can only be observed *on the device the app is running on* (e.g.
the `AudioContext` lifecycle, [`ios-audio`](ios-audio.md) session state), and remote
test rigs (BrowserStack Live, a borrowed phone) have no developer console. A keepable,
in-app readout makes such problems diagnosable without a debugger. It lives in the
About modal because that already exists, is reachable everywhere, and is non-intrusive.
This spec owns the *panel mechanics*; the **data** in each row is owned by the feature
that contributes it (so the panel does not accumulate unrelated knowledge).

v3 answers the question this spec's own "Open questions" raised: on those same
consoleless devices, *observing* a problem is only half of what you need. A
suspended `AudioContext`, an autosave the app chokes on, a stale service-worker
cache and a stuck voice are all one gesture from fixed — but until v3 the only
in-app lever was **Restore to Factory Settings**, which erases everything the
user made. The actions are the small hammers that reset was standing in for, plus
one that solves the reporting problem itself: **Copy report** puts the entire
readout on the clipboard so a remote tester can paste it into a chat window
instead of transcribing it from a phone screen.

## Requirements

- **REQ-1** — A "Debug" section in the About modal (`ui/components/about-debug.ts`,
  `buildDebugSection`), **default-collapsed**, toggled via the shared
  `createCollapseToggle` and persisted under `localStorage['websynth.debug.about']`
  (same `websynth.*` + try/catch convention as `collapse-toggle.ts`). The whole header
  row is the click target; the body carries `data-testid="debug-section"`.
- **REQ-2** — Rows are a key/value grid built by a local `addRow(name, action?)` helper
  (reusing the modal's `.keys`/`.key`/`.act` classes) that returns the value element to
  write into. The section body wraps that grid **plus** the actions block (REQ-7), so
  collapsing hides both. Built-in rows: **AudioContext** state
  (`data-testid="debug-ctx-state"`; v10 appends `· awaiting gesture` while
  `engine.audioRecovery.gestureArmed` — the state alone cannot distinguish "the OS
  took it" from "we asked and were refused"; v11 appends `· autoplay ok` while
  `engine.autoplayAllowed`, which is both why no start modal was shown
  ([audio-lifecycle](audio-lifecycle.md) REQ-20) and, on a build without REQ-19,
  the reason a boot could be heard. Notes join in that order, ` · `-separated), **Sample rate**, **Latency** (`debug-latency`,
  base/output), **Transport** (`debug-transport`: playing/stopped · `Clock.bpm` ·
  sync mode · `Clock.dropouts` — v5, the only on-device evidence of a stalled
  wakeup source, see [audio-lifecycle](audio-lifecycle.md) REQ-7), **iOS**
  (`isIOS()` yes/no), **Media session** (`debug-media-session` — v6, the Android
  keep-alive's status/`playbackState`, `n/a` elsewhere; see
  [media-session](media-session.md) REQ-8), **Background audio**
  (`debug-background` — v7, the watchdog's underrun/drift readings while hidden
  and any suspends it made; [audio-lifecycle](audio-lifecycle.md) REQ-12),
  **Local storage** (`debug-storage`, `storageUsage()`).
- **REQ-3** — Live refresh while the modal is open **and the section is expanded**:
  a single `refresh()` re-reads every row's source and runs **on open**, on the `ctx`
  `statechange` event, **and** on a ~500 ms interval (so values that change without an
  event — e.g. a media element's `currentTime` — visibly tick). The `statechange`
  listener and the interval are registered on open and **torn down in `close()`** (no
  leaks when the modal is shut). Because the section is default-collapsed (REQ-1), the
  interval and the `statechange` handler drive a **gated tick** that does nothing while
  collapsed: a reader who opens About for the credits must not pay for a readout that
  is not on screen. Expanding forces an immediate, **all-tier** repaint (REQ-11), so
  the panel is never shown stale. The visibility signal is `createCollapseToggle`'s
  existing `onChange` — which also fires once at creation with the stored/default
  state — not a new API.
- **REQ-4** — **Extension contract**: a feature adds rows inside `buildDebugSection` by
  calling `addRow` and reading either the `StudioApi` passed to
  `createAboutButton(engine, deps)` or, for state that lives outside the Engine, a
  **late-bound module hook** the owner binds at boot (the same idiom as app.ts's
  live scope knobs). Those hooks live in `state/debug-sources.ts`, not in the panel:
  a binder that runs at boot must not have to import the lazily-loaded modal to reach
  its setter ([`runtime-performance.md`](runtime-performance.md) REQ-1). No contract
  change is needed to add a row. Current
  contributors: [`ios-audio`](ios-audio.md) (Audio unlock / Silent loop, from
  `engine.iosAudio`), [`performance-mode`](performance-mode.md) (tier / cores /
  memory / mobile / audio profile), and
  [`sample-persistence`](sample-persistence.md) (**Sampler clips**,
  `data-testid="debug-sampler-clips"`, via `setClipStatsSource`),
  [`session-autosave`](session-autosave.md) (**Session autosave**, `debug-session`,
  from `SessionAutosave.stats()`), [`pwa-install`](pwa-install.md) (**Service
  worker**, `debug-sw`), [`midi-clock-sync`](midi-clock-sync.md) (**MIDI ports**,
  `debug-midi`, via `setMidiStatsSource`) and the wake lock (**Wake lock**,
  `debug-wake`, via `setWakeLockSource`).
- **REQ-5** — A row whose late-bound source is unbound reads **"n/a"** rather
  than blank or a crash, so the panel degrades cleanly in any boot order.

### v3 — actions

- **REQ-6** — **A row may carry one inline action button** in its value cell
  (`addRow(name, action)`), which is why the value is written into its own `<span>`
  — `refresh()` must not be able to wipe the button beside it. An action marked
  `danger` is styled with `dialogStyles.danger` and **must** carry `confirm` copy:
  it runs only after `confirmDialog` ([dialog](dialog.md)) resolves true, so a
  stray click can never destroy state. Current row actions:
  **Sampler clips ▸ Clear** (`debug-clips-clear`: nulls every sampler slot, then
  `SampleAutosave.clear()` for orphans), **Session autosave ▸ Clear**
  (`debug-session-clear`: `SessionAutosave.clear()` + reload) and
  **Service worker ▸ Unregister** (`debug-sw-unregister`: unregister all + reload).
  Each is the *small hammer* for something that previously needed a factory reset.
- **REQ-7** — A panel-level **actions block** (`data-testid="debug-actions"`) of
  plain buttons sits under the grid: **Resume/Suspend** (`debug-ctx-toggle`, label
  follows `ctx.state`; `engine.resume()` / `engine.suspendForDebug()` — v10: the
  suspend goes through the Engine so it is recorded as *deliberate* and the
  now-universal `statechange` re-arm leaves it alone,
  [audio-lifecycle](audio-lifecycle.md) REQ-15), **Panic**
  (`debug-panic`, `engine.panic()`), **Test tone** (`debug-test-tone`) and
  **Copy report** (`debug-copy`). The report is built from the *row registry*
  (name + current text, in order), not by scraping the DOM, prefixed with
  `__APP_VERSION__`, an ISO timestamp and the user agent, and copied via the
  shared `copyText`/`flashCopied` ([ai-prompt](ai-prompt.md)'s helpers).
- **REQ-7b** — **The test tone bypasses the master chain**: a 1 s A440 oscillator
  connected straight to `ctx.destination`. That is deliberate — it answers "is
  this device producing any sound at all?", which a muted mixer, a closed filter
  or a solo'd lane would otherwise mask. It re-triggers on a second click.
- **REQ-8** — An action whose late-bound source is **unbound renders disabled**
  (the action-side mirror of REQ-5): with no `setClipStatsSource`, clip
  persistence never started and there is nothing for Clear to clear.
- **REQ-9** — **Nothing an action starts outlives the panel.** `buildDebugSection`
  returns a `dispose()` alongside `refresh()`, called from the modal's `close()`
  next to the interval/listener teardown; it stops a ringing test tone and resets
  its button label.
- **REQ-10** — The **service-worker row is polled on its own slow schedule**
  (≥5 s, guarded by a timestamp inside `refresh()`), because
  `getRegistrations()` is async and the rows refresh every ~500 ms (REQ-3). Its
  value is cached between checks and written synchronously like every other row.

### v4 — cost

- **REQ-11** — **`refresh()` is tiered by row cost**, generalizing REQ-10's guard
  from "async" to "expensive". A row that is not due keeps the text it already has
  (no cache-and-rewrite is needed — only the async SW row needs that):
  - *every tick (~500 ms)* — plain field reads: AudioContext state + the toggle
    label, sample rate, latency, transport, iOS, sampler clips (in-memory
    bookkeeping), MIDI, wake lock, and the iOS unlock/silent-loop rows, whose
    advancing `currentTime` is the reason the tick is this fast at all.
  - *~2 s* — everything that walks `localStorage` **synchronously** or is
    near-static: **Local storage** (`storageUsage()` reads *every* `websynth.*`
    value to sum its length), **Session autosave** (`SessionAutosave.stats()`
    additionally `JSON.parse`s the whole session payload), and the five
    performance-mode rows. Perf is re-read rather than computed once so a live
    Perf-modal change still appears.
  - *~5 s* — the service worker (REQ-10, unchanged).

  The rationale is that this panel exists for weak, console-less devices: blocking
  the main thread on a full `localStorage` walk twice a second while audio plays
  risks dropouts, which would make the diagnostic tool a cause of the very symptom
  it is opened to diagnose. `refresh(force)` runs **all** tiers, and is used for the
  initial build and for the expand repaint (REQ-3).

## Technical design

### Contract / public interface

```yaml
# src/ui/components/about-button.ts   — EAGER. The only part of About on the boot path.
createAboutButton(engine: StudioApi, deps: { startTour(): void }): HTMLButtonElement
  # deps is the tour hook the modal's "Take the guided tour" button calls
  # (onboarding.md REQ-20) — injected, so About never imports onboarding.
  # Owns the open/close lifecycle (backdrop cache, Escape, the 500 ms refresh
  # tick) and `import()`s about-modal.ts on the click that opens it
  # (runtime-performance.md REQ-1). `open` is async; the click handler voids it.
AboutDeps { startTour(): void }        # declared here; about-modal imports it type-only

# src/state/debug-sources.ts  — EAGER leaf. Lives outside the modal precisely so
# main.ts can bind the rows at boot without pulling the modal into the entry chunk.
setClipStatsSource(fn: () => { count: number; bytes: number }): void   # late-bound row source
setMidiStatsSource(fn: () => { inputs: number; outputs: number }): void
setWakeLockSource(fn: () => { supported: boolean; held: boolean }): void
clipStats(): { count: number; bytes: number } | undefined   # undefined = unbound -> "n/a"
midiStats(): { inputs: number; outputs: number } | undefined
wakeState(): { supported: boolean; held: boolean } | undefined

# src/ui/components/about-modal.ts     — LAZY. buildModal + buildFactoryResetButton.
buildModal(close, engine, deps): { backdrop, refreshDebug, disposeDebug }

# src/ui/components/about-debug.ts     — LAZY.
# internal: buildDebugSection(engine) -> { header, body, refresh, dispose }
#   refresh is the *gated* tick (a no-op while collapsed, REQ-3); the ungated
#   refresh(force?) it wraps runs all polling tiers when force is true (REQ-11)
#   addRow(name, action?): HTMLElement  # key cell + value cell (+ button); returns
#                                       # the element `refresh` writes text into
#   RowAction: { label, testId, onClick, danger?, confirm? }
# testids: debug-section (body), debug-actions, debug-ctx-state, debug-ctx-toggle,
#          debug-panic, debug-test-tone, debug-copy, debug-latency, debug-transport,
#          debug-storage, debug-session(+-clear), debug-sw(+-unregister), debug-midi,
#          debug-wake, debug-sampler-clips(+ debug-clips-clear), debug-perf-tier,
#          debug-ios-*

# what the rows read (owned by their own specs)
SessionAutosave.stats(): { bytes, savedAt: number | null } | null   # session-autosave.ts
storageUsage(prefix = 'websynth.'): { keys, bytes }                 # slot-store.ts
WakeLockManager.held: boolean                                       # utils/wake-lock.ts
Clock.bpm: number                                                   # transport clock
Clock.dropouts: number                              # v5: stalled-wakeup recoveries (transport.md REQ-9)
Engine.mediaSession: MediaSessionDiagnostics        # v6: Android keep-alive (media-session.ts)
Engine.backgroundAudio: WatchdogDiagnostics         # v7: background-watchdog.ts
initMIDI(engine, bus): Promise<MIDIAccess | null>                   # resolves the handle
```

`Clock.bpm` and `initMIDI`'s return value are new accessors, not new state.
`bpm` is worth surfacing because a **slaved** clock is driven by `setBpm` from
incoming MIDI pulses and never touches the bus
([midi-clock-sync](midi-clock-sync.md)), so `transport.bpm` can legitimately
disagree with what is actually playing — precisely the kind of thing this panel
exists to make visible. `initMIDI` returns its `MIDIAccess` so **`main.ts`** can
bind the port-count source: the audio layer must never import UI, and `midi.ts`
stays the sole owner of the handle.

### Persistence

`localStorage['websynth.debug.about']` = collapse state (`0|1`), default collapsed.
Nothing else is persisted — the panel only *reflects* live state.

## Scenarios (BDD)

```gherkin
Scenario: Debug section is present and collapsed by default
  Given the About modal is opened with no stored collapse preference
  Then a Debug section exists and has the collapsed class
# pinned by: tests/ui/about.test.ts

Scenario: A row reflects live AudioContext state
  Given the modal is open and ctx.state is "suspended"
  When a statechange fires and ctx.state becomes "running"
  Then the AudioContext row updates to "running"
# pinned by: tests/ui/about.test.ts

Scenario: The row names the autoplay verdict (v11)
  Given the browser let the context start without a gesture
  Then the AudioContext row reads "running · autoplay ok"
   And a browser that demanded the tap leaves the note off entirely
# pinned by: e2e/debug-panel.spec.ts

Scenario: Clicking the header expands the section
  Given the Debug section is collapsed
  When its header is clicked
  Then the section is no longer collapsed
# pinned by: tests/ui/about.test.ts

Scenario: A late-bound row with no source reads n/a, and its action is disabled (edge)
  Given nothing has called setClipStatsSource
  When the About modal is opened
  Then the Sampler clips row reads "n/a"
  And its Clear button is disabled
# pinned by: tests/ui/about.test.ts

Scenario: The context toggle follows and drives the AudioContext (REQ-7)
  Given the context is suspended
  Then the action reads "Resume" and calls engine.resume()
  When the context becomes running
  Then it reads "Suspend" and calls engine.suspendForDebug()
# pinned by: tests/ui/about.test.ts, e2e/debug-panel.spec.ts

Scenario: The context row says when a resume is waiting for a gesture (v10)
  Given every automatic resume attempt failed and the gesture fallback is armed
  Then the AudioContext row reads "suspended · awaiting gesture"
  When the context comes back
  Then the suffix is gone
# pinned by: tests/ui/about.test.ts

Scenario: The test tone goes straight to the destination (REQ-7b)
  When Test tone is pressed
  Then a 440 Hz oscillator is started outside the master chain
  And closing the panel stops it
# pinned by: tests/ui/about.test.ts

Scenario: Copy report carries the whole readout (REQ-7)
  When Copy report is pressed
  Then the clipboard holds the version, the user agent and every row's value
# pinned by: tests/ui/about.test.ts, e2e/debug-panel.spec.ts

Scenario: A destructive action asks first (REQ-6)
  Given an autosaved session exists
  When Clear is pressed and the confirm is cancelled
  Then the session is still stored
# pinned by: tests/ui/about.test.ts, e2e/debug-panel.spec.ts

Scenario: A collapsed section does no work (REQ-3)
  Given the modal is open and the Debug section is collapsed
  When the refresh interval fires repeatedly
  Then no row source is read at all
# pinned by: tests/ui/about.test.ts

Scenario: Expanding repaints immediately (REQ-3)
  Given the modal is open and the Debug section is collapsed
  When the header is clicked to expand it
  Then every row is repainted before the next interval tick
# pinned by: tests/ui/about.test.ts

Scenario: Expensive rows are not re-read on every tick (REQ-11)
  Given the Debug section is expanded
  When one ~500 ms tick fires
  Then the transport row is re-read but localStorage is not walked
  When more than 2 s of ticks have fired
  Then the Local storage and Session autosave rows are re-read
# pinned by: tests/ui/about.test.ts
```

## Tests & verification

- Unit: `tests/ui/about.test.ts` (presence + default-collapsed + live refresh +
  expand + every action, plus the v4 cost gates: collapsed does nothing, expanding
  repaints, and the expensive rows tick on the slow schedule — under fake timers),
  `tests/state/session-autosave.test.ts` (`stats`),
  `tests/state/storage-usage.test.ts` (`storageUsage`) — `npm test`
- E2E: `e2e/debug-panel.spec.ts` (the actions against a real AudioContext +
  clipboard) — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- A rolling in-app error log (last N `window.onerror` / unhandled rejections)
  would be the natural next row — it is the one class of problem the panel still
  cannot show without a console.
- The report is plain text; a "share" action (Web Share API) would beat
  clipboard-then-paste on phones.
