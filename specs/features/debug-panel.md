# Debug panel

```yaml
id: debug-panel
status: implemented
version: 2
owner: core
related:
  - architecture
  - ios-audio
  - performance-mode
  - sample-persistence
source:
  - src/ui/components/about.ts
```

A small, **reusable** diagnostics panel inside the About modal: a default-collapsed
"Debug" section that renders a live key/value list of runtime state. Features
contribute their own rows — it is intentionally generic and extensible, not tied to
any one feature.

## Background / Why

Some runtime state can only be observed *on the device the app is running on* (e.g.
the `AudioContext` lifecycle, [`ios-audio`](ios-audio.md) session state), and remote
test rigs (BrowserStack Live, a borrowed phone) have no developer console. A keepable,
in-app readout makes such problems diagnosable without a debugger. It lives in the
About modal because that already exists, is reachable everywhere, and is non-intrusive.
This spec owns the *panel mechanics*; the **data** in each row is owned by the feature
that contributes it (so the panel does not accumulate unrelated knowledge).

## Requirements

- **REQ-1** — A "Debug" section in the About modal (`ui/components/about.ts`,
  `buildDebugSection`), **default-collapsed**, toggled via the shared
  `createCollapseToggle` and persisted under `localStorage['websynth.debug.about']`
  (same `websynth.*` + try/catch convention as `collapse-toggle.ts`). The whole header
  row is the click target; the body carries `data-testid="debug-section"`.
- **REQ-2** — Rows are a key/value grid built by a local `addRow(name)` helper (reusing
  the modal's `.keys`/`.key`/`.act` classes) that returns the value element to write
  into. Built-in rows: **AudioContext** state (`data-testid="debug-ctx-state"`), **iOS**
  (`isIOS()` yes/no), **Sample rate**.
- **REQ-3** — Live refresh while the modal is open: a single `refresh()` re-reads every
  row's source and runs **on open**, on the `ctx` `statechange` event, **and** on a
  ~500 ms interval (so values that change without an event — e.g. a media element's
  `currentTime` — visibly tick). The `statechange` listener and the interval are
  registered on open and **torn down in `close()`** (no leaks when the modal is shut).
- **REQ-4** — **Extension contract**: a feature adds rows inside `buildDebugSection` by
  calling `addRow` and reading either the `StudioApi` passed to
  `createAboutButton(engine)` or, for state that lives outside the Engine, a
  **late-bound module hook** the owner binds at boot (the same idiom as app.ts's
  live scope knobs). No contract change is needed to add a row. Current
  contributors: [`ios-audio`](ios-audio.md) (Audio unlock / Silent loop, from
  `engine.iosAudio`), [`performance-mode`](performance-mode.md) (tier / cores /
  memory / mobile / audio profile), and
  [`sample-persistence`](sample-persistence.md) (**Sampler clips**,
  `data-testid="debug-sampler-clips"`, via `setClipStatsSource`).
- **REQ-5** — A row whose late-bound source is unbound reads **"n/a"** rather
  than blank or a crash, so the panel degrades cleanly in any boot order.

## Technical design

### Contract / public interface

```yaml
# src/ui/components/about.ts
createAboutButton(engine: StudioApi): HTMLButtonElement
setClipStatsSource(fn: () => { count: number; bytes: number }): void   # late-bound row source
# internal: buildDebugSection(engine) -> { header, body, refresh }
#   addRow(name: string): HTMLElement   # appends a key cell + value cell, returns the value cell
# testids: debug-section (body), debug-ctx-state (+ feature rows, e.g. debug-ios-*,
#          debug-perf-tier, debug-sampler-clips)
```

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

Scenario: Clicking the header expands the section
  Given the Debug section is collapsed
  When its header is clicked
  Then the section is no longer collapsed
# pinned by: tests/ui/about.test.ts

Scenario: A late-bound row with no source reads n/a (edge)
  Given nothing has called setClipStatsSource
  When the About modal is opened
  Then the Sampler clips row reads "n/a"
# pinned by: tests/ui/about.test.ts
```

## Tests & verification

- Unit: `tests/ui/about.test.ts` (presence + default-collapsed + live refresh + expand) — `npm test`
- Typecheck: `npm run typecheck`

## Open questions / future

- Rows are read-only today; an interactive debug action (e.g. a "force resume" button)
  could be added without changing the panel contract.
