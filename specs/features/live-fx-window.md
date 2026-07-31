# LIVE FX window

```yaml
id: live-fx-window
status: implemented
version: 2
owner: core
related:
  - performance
  - floating-window
  - xy-pad
  - song-mode
  - onboarding
  - transport-window
source:
  - src/ui/components/live-fx.ts          # shared DJ-control builder + LIVE FX window launcher
  - src/ui/components/xy-pad-window.ts     # single shared XY Pad window controller
  - src/ui/panels/song-panel.ts           # hosts both launchers in the Live FX row
  - src/ui/components/floating-window.ts   # the host window
```

## Background / Why

The live [DJ FX](performance.md) (DJ Filter, Fill, Stutter, Drop, Tape Stop) lived
only inside the Song tab's "Live FX" row, so they were unreachable while editing a
patch on another tab. This feature surfaces them in a non-modal
[FloatingWindow](floating-window.md) titled **"LIVE FX"** that — like every floating
window — is appended to `document.body` and therefore keeps floating over **any**
tab once opened. It becomes the hub for live-performance tools by also hosting an
**XY Pad launcher**.

The DJ controls were previously built inline in `buildSongPanel`; they are extracted
into a shared builder so the Song panel and the LIVE FX window render the *same*
controls from one source (DRY). Because the XY Pad can now be launched from two
places (the Song panel and the LIVE FX window), its window is owned by a single
shared controller so both launchers toggle one instance (never two).

## Requirements

- **REQ-1** — **Shared DJ-control builder**: `buildLiveFxControls(engine, opts?)`
  builds the momentary DJ controls — Fill, Stutter (+ bar-size segmented 1 / 1/8 /
  1/4), Drop, Tape Stop — bound to `engine.perf.*`, identical in behaviour to the
  old inline Song-panel controls. `opts.testIdPrefix` (default `'perf'`) prefixes
  every testid so a second instance can coexist without id collisions. The Song
  panel keeps `perf-*`; the LIVE FX window uses `livefx-*`. The DJ Filter knob is
  NOT part of the builder (it needs `bus`); each caller adds its own one-liner.
- **REQ-2** — **LIVE FX floating window**: a launcher button (`livefx-open`) toggles
  a `FloatingWindow` (`title: 'LIVE FX'`, `testId: 'livefx-window'`). Its body
  contains, in order: a DJ Filter `Knob` (`fx.djfilter`), the shared DJ controls
  (`testIdPrefix: 'livefx'`), and an XY Pad launcher button (`livefx-xypad`). The
  window is built lazily on first open and kept alive across closes.
- **REQ-6** — **Launcher doubles as the Song-panel section title**: in the Song
  panel's Live FX row the `livefx-open` button *replaces* the old "Live FX" text
  label (saving space) and leads the row. It carries a small "opens a new window"
  glyph (`❐`, aria-hidden; the button's `aria-label` is "Open LIVE FX window"). The
  Song-panel row order is: **LIVE FX launcher → DJ Filter knob → Fill → Stutter →
  Drop → Tape Stop → XY Pad → master COMP**.
- **REQ-3** — **Single shared XY Pad window**: `createXyPadWindowController(bus, xy)`
  owns exactly one XY Pad `FloatingWindow`. Both the Song-panel XY launcher
  (`perf-xypad`) and the LIVE FX window's XY launcher (`livefx-xypad`) call the same
  controller's `toggle()`, so only one `xypad-window` ever exists. Launcher buttons
  reflect open state (`.on`) via the controller's `onChange`.
- **REQ-4** — **Reachable off the Song tab**: because floating windows mount on
  `document.body` (not inside a tab panel), an open LIVE FX (or XY Pad) window stays
  visible and interactive after switching to another tab.
- **REQ-5** — **Minimise**: the LIVE FX window inherits the built-in minimise button
  from [FloatingWindow](floating-window.md) REQ-7 (no extra work here).
- **REQ-7** — **The row carries a help badge** on its launcher — which is also its
  section title (REQ-6), so the badge sits on the row's leading control, exactly as
  the transport row's does ([transport-window](transport-window.md) REQ-10). Topic
  `song.fx` ([onboarding](onboarding.md) REQ-16), written as that topic's sibling
  and covering the same ground in the same order: what the row is, each control
  (DJ&nbsp;Filter, Fill, Stutter + its size, Drop, Tape&nbsp;Stop, XY&nbsp;Pad),
  what the floating window adds, and the states where an effect is reduced. It
  must **not** re-explain the master compressor sharing the row — `fx.master.comp`
  is its own badge — nor the XY Pad's assignment, which is `motion.xy`'s.
  Without it, Live FX was the only unbadged section on the Song tab.

## Technical design

### Contract / public interface

```yaml
buildLiveFxControls(engine: StudioApi, opts?: { testIdPrefix?: string }): HTMLElement[]
  # returns [Fill, StutterWrap(+size), Drop, TapeStop]; testids `${prefix}-fill`,
  # `${prefix}-stutter`, `${prefix}-stutter-size-<n>`, `${prefix}-drop`, `${prefix}-tapestop`

createLiveFxWindowLauncher(engine: StudioApi, bus: ParamBus, xyWin: XyPadWindowController): HTMLButtonElement
  # the `livefx-open` toggle button; builds/owns the LIVE FX FloatingWindow lazily

createXyPadWindowController(bus: ParamBus, xy: XyPadStore): XyPadWindowController
XyPadWindowController:
  toggle(): void
  isOpen(): boolean
  onChange(cb: (open: boolean) => void): () => void   # returns unsubscribe
xyPadLaunchButton(win: XyPadWindowController, testId: string): HTMLButtonElement
  # a `switchStyles.root + djBtn` button labelled "XY Pad"; toggles the shared window,
  # mirrors `.on` via win.onChange
```

### Layer touchpoints & ordering

```yaml
song-panel: builds one `xyWin = createXyPadWindowController(bus, xy)`. Live FX row =
  createLiveFxWindowLauncher(engine, bus, xyWin)  # `livefx-open`, doubles as the section title
  -> DJ FLT Knob(fx.djfilter) -> buildLiveFxControls(engine)  # Fill / Stutter / Drop / Tape Stop
  -> xyPadLaunchButton(xyWin, 'perf-xypad') -> master COMP fxGroup.
  The separate "Live FX" text label is removed (the launcher names the section).
live-fx window body: DJ FLT Knob(fx.djfilter) -> buildLiveFxControls(engine, {testIdPrefix:'livefx'})
  -> xyPadLaunchButton(xyWin, 'livefx-xypad').
perf: all momentary controls call engine.perf.setFill/setStutter/setStutterSize/
  setDrop/setTapeStop; DJ Filter drives ParamBus fx.djfilter (engine forwards to
  perf.setDjFilter) — unchanged from performance.md.
```

Note: both DJ Filter knobs bind the same param `fx.djfilter`, so both carry the
auto-minted testid `knob-fx.djfilter`; e2e must scope the LIVE FX one within
`livefx-window`.

## Visual aids

```
Song panel "Live FX" row (the LIVE FX button replaces the old section title):
  [LIVE FX ❐] [DJ FLT] [Fill] [Stutter |1|1/8|1/4|] [Drop] [Tape Stop] [XY Pad] [COMP …]
   livefx-open                                                          perf-xypad

FloatingWindow "LIVE FX"  (opened by livefx-open; floats over any tab)
 ┌───────────────────────────────────────┐
 │ −  LIVE FX                           ✕ │   minimise (FloatingWindow REQ-7)
 │ [DJ FLT] [Fill] [Stutter |…|] [Drop]  │   livefx-fill / livefx-stutter / …
 │ [Tape Stop] [XY Pad]                  │   livefx-xypad -> shared xypad-window
 └───────────────────────────────────────┘
```

## Scenarios (BDD)

```gherkin
Scenario: The LIVE FX window opens from the Song panel and hosts the DJ controls
  Given the Song tab is open
  When the user clicks the LIVE FX button (livefx-open)
  Then a floating window (livefx-window) appears containing DJ Filter, Fill,
       Stutter (+ size), Drop, Tape Stop, and an XY Pad launcher
# pinned by: e2e/live-fx.spec.ts

Scenario: A LIVE FX control drives the same Performance state as the Song panel
  Given the LIVE FX window is open
  When the user holds livefx-fill
  Then engine.perf fill is active (same as pressing perf-fill)
# pinned by: tests/ui/live-fx.test.ts, e2e/live-fx.spec.ts

Scenario: Both XY Pad launchers toggle a single shared window
  Given the LIVE FX window is open
  When the user clicks its XY Pad launcher (livefx-xypad)
  Then exactly one xypad-window exists
  And clicking the Song panel's XY Pad button (perf-xypad) closes that same window
# pinned by: e2e/live-fx.spec.ts

Scenario: The LIVE FX window stays usable after switching tabs
  Given the LIVE FX window is open on the Song tab
  When the user switches to the Synth tab
  Then the LIVE FX window is still visible and its controls still drive the engine
# pinned by: e2e/live-fx.spec.ts

Scenario: The row carries a help badge on its launcher (REQ-7)
  Given the info badges are on and the Song tab is open
  Then a `song.fx` badge anchors to the LIVE FX launcher
  And its topic names every control in the row and what the window adds
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts
```

## Tests & verification

- Unit: `tests/ui/live-fx.test.ts` (builder testids + perf wiring),
  `tests/ui/floating-window.test.ts` (minimise) — `npm test`.
- E2E: `e2e/live-fx.spec.ts`; `e2e/xy-pad.spec.ts` + `e2e/song-fx.spec.ts` stay
  green (shared-controller refactor is behaviour-preserving) — `npm run e2e`.
- Typecheck: `npm run typecheck`.

## Open questions / future

- A header entry point (always-visible button) could complement the Song-panel
  launcher; deferred — the window persists across tabs once opened.
