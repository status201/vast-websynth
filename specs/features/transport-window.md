# TRANSPORT window (Song-panel transport section)

```yaml
id: transport-window
status: implemented
version: 8
owner: core
related:
  - transport
  - transport-position
  - typography          # REQ-the-position-readout-is-bar-dot-step's mono readout generalises there (REQ-the-transport-launcher-is-the-section-title)
  - floating-window
  - live-fx-window
  - song-mode
  - arrangement
  - midi-clock-sync
  - onboarding
  - transport-loop      # the Loop button + scrubber picks this row carries
  - resize-handle       # the window's width grip (REQ-the-window-width-is-resizable)
source:
  - src/ui/components/transport-controls.ts   # shared builder + window launcher
  - src/ui/panels/song-panel.ts               # hosts the compact row
  - src/ui/components/floating-window.ts      # the host window
  - src/audio/transport/arrangement.ts        # songBars — how long the scrubber is
  - src/state/size-pref.ts                  # the remembered width
```

## Background / Why

[transport-position](transport-position.md) gives every machine tab a ruler for the
16th **within a bar**; it cannot show which bar of an `A A B A` chain you are on, or
jump to bar 3. The Song tab holds the chain lanes, so the song-scale transport lives
there, and, as with [live-fx-window](live-fx-window.md), a launcher opens a non-modal
[FloatingWindow](floating-window.md) on `document.body` that keeps working from any
tab. The row and the window carry the **same** control set, including **Play/Pause**
(the one verb nothing else on screen offers) and **Loop**
([transport-loop](transport-loop.md)).

**BPM and SWING are not here, on either surface.** The header owns them, they are set
per song rather than performed, and a copy would silently disagree: the header's BPM
knob is disabled while slaved ([midi-clock-sync](midi-clock-sync.md)
REQ-the-bpm-knob-shows-slaved), and a second one would need its own lock wiring to
show the state ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 5).

## Requirements

- **REQ-one-transport-control-builder** — **Shared builder.**
  `buildTransportControls(engine, bridge, opts?)` renders the transport control
  set from one source; `opts.testIdPrefix` namespaces every testid so two
  instances coexist (the Song row uses `transport`, the window `transportw`),
  the same mechanism [live-fx-window](live-fx-window.md)
  REQ-one-builder-for-dj-controls uses. Both surfaces render the **same** controls.

- **REQ-transport-is-a-floating-window** — **TRANSPORT floating window.** A
  launcher (`transport-open`) toggles a `FloatingWindow` titled **TRANSPORT**
  (`testId: transport-window`), built lazily on first open and kept alive across
  closes. Contents in order: Play/Pause, ⏮ return-to-start, the `bar.step`
  readout, Loop, Follow, the bar scrubber. It takes no `ParamBus` — **neither surface
  mints a second `transport.bpm` or `transport.swing` knob** (see *Background*);
  the header's are the only ones.

- **REQ-the-transport-launcher-is-the-section-title** — **The launcher doubles
  as the section title**, leading the Song panel's transport row and carrying
  the same "opens a new window" icon as the LIVE FX launcher (`UI_ICONS.popOut`,
  aria-hidden; the button's `aria-label` carries the meaning). No separate text
  label.

- **REQ-the-song-panel-transport-row** — **Song-panel row**:
  `[TRANSPORT ↗] [Play/Pause] [⏮] [bar.step] [Loop] [Follow] [bar scrubber]`, placed
  **directly under the four machine lanes and above Live FX**. The scrubber is one
  cell per chain slot, so it reads as a ruler for the chains above it: a scrubber
  bar and a lane chip mean the same bar. Don't move it down by Sync, away from the
  chains that give the readout its meaning.

- **REQ-play-pause-is-not-a-second-truth** — **Play/Pause is not a second source
  of truth.** Stopped, a click **plays** through
  `UiBridge.toggleTransport`, which clicks the *real* header button. That way it
  gets the [empty-play hint](empty-play-hint.md) intercept and the [Play-button
  blink](play-button-blink.md) state machine without extra code, and starts from
  `clock.cue`, which is the resume point after a pause. Playing, a click
  **pauses** through `clock.pause()` ([transport](transport.md)
  REQ-pause-resumes-where-it-stopped). Pause cannot go through the header, whose
  click means *stop*, and it needs neither the hint (stops are never
  intercepted) nor the blink wiring (driven by `onStop`). The label and `.on`
  follow `clock.onStart`/`onStop`, exactly as the header button's do, so all
  three buttons always agree about whether the transport is running.

- **REQ-the-position-readout-is-bar-dot-step** — **Position readout.**
  `bar.step`, 1-based (bar 1 step 1 at the top). Playing, it shows the live
  step; stopped, the **cue** — where Play will begin — matching the machine-tab
  rulers ([transport-position](transport-position.md) REQ-a-position-ruler-above-every-grid), so the two
  surfaces can never disagree about "where are we?". **The bar wraps at song
  length**: it is the *same* `bar % bars` value that lights the scrubber
  cell (REQ-the-bar-scrubber), computed once for both, so a one-bar song never
  counts `2.01, 3.01 …` beside a single cell ([transport-position](transport-position.md)
  REQ-the-readout-never-invents-bars, ADR-014 law 5). The step term is the 16th
  within the bar. It is set in `--mono`, so it moves only when the digit count
  changes; Georgia's figures are proportional and have no `tnum`
  ([typography](typography.md)).

- **REQ-the-bar-scrubber** — **Bar scrubber.** One cell per bar of the song,
  current bar lit, click to seek to the top of that bar. Song length is
  `Arrangement.songBars()` — the longest **enabled** chain lane across all four
  lanes — falling back to a single bar when no lane is enabled. The DOM is
  rebuilt only when that length changes; the lit class moves in place otherwise,
  the same split-rendering rule the chain chips already follow.

- **REQ-seeking-respects-the-one-guard** — **Seeking respects the one guard.**
  Both the ⏮ and the scrubber go through `StudioApi.seekTo`, and both surfaces
  mark themselves inert when `canSeek()` is false
  ([transport-position](transport-position.md) REQ-seeking-is-refused-in-three-states/REQ-one-seek-entry-point).

- **REQ-the-chain-chips-are-left-alone** — **The chain chips are left alone.** A
  chip click already toggles the edit selection that ◀ ▶ ✕ act on
  ([song-mode](song-mode.md)); adding a seek to it would give one gesture two
  outcomes, which [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2
  forbids. The scrubber is a separate target sitting above them.

- **REQ-the-transport-row-carries-a-help-badge** — **The row carries a help
  badge** on its launcher — which is also its section title, so the badge sits
  on the row's leading control. Topic `transport.song`
  ([onboarding](onboarding.md) REQ-the-playhead-ruler-carries-a-badge): the `bar.step` readout, the scrubber's
  one-cell-per-chain-slot correspondence, what the floating window adds, and the
  states where seeking is refused (REQ-seeking-respects-the-one-guard). It
  also covers Play/Pause against the header's Play/Stop
  (REQ-pause-and-stop-are-separate-verbs) and Loop
  ([transport-loop](transport-loop.md) REQ-loop-discoverability).

- **REQ-the-scrubber-presents-as-a-timeline** — **The scrubber presents as a
  timeline, not a row of links.** Square cells (no border radius) the height of
  the buttons beside them, sitting on a near-black bed whose gaps read as the
  segment dividers between bars — the transport strip of a DAW
  ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 4, follow
  precedent), not a paginator. It is **one line**: a song longer than the row
  scrolls horizontally rather than wrapping into a block, so the row's height is
  the same for a 4-bar song and a 64-bar one. **It keeps its place on the
  controls' line**: its flex basis is about eight cells, not its content width,
  so a long song stays beside Follow and scrolls, and the strip wraps to a line of
  its own only when fewer than eight cells' width is left (a phone). It grows
  into the free space but never past its own cells, so a short song's window is
  still as narrow as its content — and a long song's window, at its cap, is full
  rather than carrying a wrapped strip beside empty space. While Follow is on
  (REQ-follow-keeps-the-playhead-in-view) the lit cell is scrolled back into
  view when it leaves it — computed on the scroller's own `scrollLeft` (never
  `scrollIntoView`, which may scroll the page too), inside the same *bar
  changed* guard as the lit class, so it costs nothing per tick
  ([runtime-performance](runtime-performance.md)). The cells carry **no CSS
  transition**: the lit class moves under the playhead, and a cross-fade would cost
  paints after every move while conveying nothing.

- **REQ-bar-step-counts-the-songs-bar** (v4) — **`bar.step` counts the song's
  bar.** Both halves of the readout, the scrubber's per-bar seek and the
  bar-cell lighting measure with `barTicks` rather than a fixed 16
  ([meter](meter.md) REQ-bar-ticks-is-the-arrangement-bar-line) — so in 3/4 the step half runs 01..12 and bar 2
  begins at tick 12. REQ-the-position-readout-is-bar-dot-step's
  wrap-at-song-length rule is unchanged and still applies on top.

- **REQ-pause-and-stop-are-separate-verbs** (v5) — **Pause and Stop are separate
  verbs, with one of each on screen.** The header keeps **Play/Stop** and the
  Space bar still toggles it: Stop means "back to the cue". The song transport's
  button is **Play/Pause**: Pause means "stay here" ([transport](transport.md)
  REQ-pause-resumes-where-it-stopped). Neither button changes meaning with
  state. Each does one thing when the transport runs and one when it does not
  (law 2), and each label names what a click will do. After a pause, the readout
  and the rulers' cue ring show the resume point, since that is `clock.cue`
  (REQ-the-position-readout-is-bar-dot-step); pressing the header's Play also
  resumes there. The button is wide enough for "Pause", so the row does not
  shift. Precedent: Elektron PLAY beside STOP; MPC PLAY and PLAY START.

- **REQ-shift-space-pauses** (v6) — **`Shift`+`Space` is the keyboard's Pause.**
  `Space` stays Play/Stop (the header's verbs); `Shift`+`Space` does what the song
  transport's Play/Pause button does — pause when running, continue from the cue
  when not — so the two verbs of REQ-pause-and-stop-are-separate-verbs each have a
  key. Shift turns Space into the gentler verb. The Play/Pause button's `title`
  names the key, and the About shortcut list carries it.

- **REQ-loop-lives-on-the-transport-row** (v5) — **Loop lives on this row.**
  Between the readout and the scrubber, because its picks land on the scrubber.
  The button, the picking mode and the range drawn on the cells are specified in
  [transport-loop](transport-loop.md). This spec owns only where it sits and
  that both surfaces carry it (REQ-one-transport-control-builder).

- **REQ-follow-keeps-the-playhead-in-view** (v7) — **Follow decides whether the
  timeline chases the playhead.** A latched **Follow** button sits between Loop
  and the scrubber, **on by default**. On, the lit cell is kept in view
  (REQ-the-scrubber-presents-as-a-timeline). Off, nothing writes the scroller's
  `scrollLeft`, so the user can scroll to the end of a playing song and stay
  there instead of being pulled back once a bar. Turning it back on scrolls every
  surface to the lit cell at once, so the strip catches up without waiting for
  the next bar. **One setting for both surfaces**: the Song row and the window
  show the same transport, so their Follow buttons are the same switch (law 5 —
  two that could disagree would each lie about the other). It is a view
  preference, not sound: no `ParamBus` param, not stored in a preset or song,
  and not persisted — every session starts following. Seeking, Loop and the lit
  class are unaffected.

  | Gesture | Target | Outcome |
  | --- | --- | --- |
  | click / tap | Follow | toggles following on both surfaces |
  | Enter / Space | focused Follow | the same — it is a native `<button>` |

- **REQ-the-window-width-is-resizable** (v8) — **The TRANSPORT window's width
  can be dragged** with a right-edge grip ([floating-window](floating-window.md)
  REQ-a-window-may-be-resizable, `transport-window-resize`), so a long song
  shows more bars than the automatic width's 880 px cap allows.
  - **Automatic until dragged.** With no stored width the window is
    shrink-to-fit up to `min(90vw, 880px)`, exactly as without the grip. A
    dragged width is written as `--transport-w` on the window and replaces both
    the automatic width and its cap.
  - **The limits come from the row.** The minimum is the controls plus
    `min(192 px, the strip)`, so a narrow window never wraps the strip onto a line
    of its own (REQ-the-scrubber-presents-as-a-timeline). The maximum is the
    controls plus the whole strip, so every bar shows: dragging further would only
    add empty space beside the last bar, the very thing that requirement removed.
    When the song is short enough that the two meet, the grip hides.
  - **Re-checked when the song's length changes**, through the builder's
    `onStructure` hook, which fires only when the scrubber is rebuilt. It is never
    wired to `arrangement.onChange`, which fires once per bar
    ([runtime-performance](runtime-performance.md)). A shorter song narrows the
    window without forgetting the stored width, which comes back with a longer
    one.
  - **Double-tap or `Home` on the grip forgets it**: the width is back to
    automatic and the stored value is removed.
  - **Remembered** under `websynth.ui.window.transport.width` (see
    Persistence), read when the window is first built and written once per
    gesture.

## Technical design

### Contract / public interface

```yaml
buildTransportControls(engine, bridge, opts?): HTMLElement[]
  # opts: { testIdPrefix?: string (default 'transport'),
  #         onStructure?: () => void }  # after the scrubber is rebuilt — only when
  #         the bar count changes, never per bar (REQ-the-window-width-is-resizable)
  # [Play/Pause, ⏮, readout, Loop, Follow, scrubber]
  # testids: `${p}-toggle`, `${p}-tostart`, `${p}-readout`, `${p}-loop`,
  #          `${p}-follow`, `${p}-scrub`, `${p}-scrub-<bar>`
  # Follow: module-level, shared by every instance (REQ-follow-keeps-the-playhead-in-view);
  #   the button carries the global `on` class + aria-pressed while following.
  # NOT `${p}-play`: the header's own Play button is `transport-play`, and a
  # default-prefixed instance would mint a duplicate of it.
  # NO ParamBus: it owns no params, so it cannot duplicate a header knob (REQ-transport-is-a-floating-window).

createTransportWindowLauncher(engine, bridge): HTMLButtonElement
  # the `transport-open` toggle; owns the TRANSPORT FloatingWindow lazily

Arrangement:                                  # src/audio/transport/arrangement.ts
  songBars(lanes?): number    # longest ENABLED lane length; 0 when none enabled.
                              # `lanes` narrows which lanes count — the scrubber
                              # asks about all four, audio export about the three
                              # audible ones (audio-export.md REQ-export-song-renders-from-the-top unchanged).
```

### Layer touchpoints & ordering

```yaml
song-panel: transport row = createTransportWindowLauncher(engine, bridge)
  -> buildTransportControls(engine, bridge)          # the same set as the window
  section order: chain lanes -> TRANSPORT -> Live FX -> Song I/O -> Audio -> Sync
window body: buildTransportControls(engine, bridge, { testIdPrefix:'transportw' })
play: UiBridge.toggleTransport -> the header button's click (REQ-play-pause-is-not-a-second-truth) — never
  clock.toggle() directly, or the empty-play hint and the LED blink are bypassed
pause: clock.pause() — only ever while playing, so it can never stand in
  for the header's Stop
loop: StudioApi.loop — see transport-loop.md
seek: StudioApi.seekTo only (REQ-seeking-respects-the-one-guard)
repaint: clock.onTick / onSeek / onStart / onStop for the readout + scrubber lit
  class; arrangement.onChange for the scrubber's structure
```

`buildTransportControls` takes the `UiBridge` because REQ-play-pause-is-not-a-second-truth forbids it owning a
transport toggle of its own — that is the same seam `shortcuts.ts` uses to drive
Play from the space bar.

### Persistence

The window's **width**, once the user has set one
(REQ-the-window-width-is-resizable):

```yaml
websynth.ui.window.transport.width: px  # state/size-pref.ts; absent = automatic
```

It is a device-scoped workspace preference, like `websynth.ui.scope.height`: not a
`ParamBus` param, never in a preset or song. The window's open state and position
are ephemeral, as with every [floating window](floating-window.md), and so is
Follow (REQ-follow-keeps-the-playhead-in-view).

## Visual aids

```
Song panel, top down — the transport row sits against the chains it scrubs
(REQ-the-song-panel-transport-row), so a scrubber cell and a chain chip name the same bar:

  ┌ SEQUENCER ┐ ┌ DRUMS ┐ ┌ SAMPLER ┐ ┌ MOTION ┐
  │ A A B A   │ │ …     │ │ …       │ │ …      │   the four lane cards
  └───────────┘ └───────┘ └─────────┘ └────────┘
  [TRANSPORT ↗] [Play] [⏮] 3.01 [Loop] [Follow] ▏1▕2▕3▕4▏  <- this row
   transport-open -toggle -tostart -readout -loop -follow -scrub-<bar>
  [LIVE FX ↗] [DJ FLT] [Fill] [Stutter] …          Live FX, then Song I/O,
                                                    Audio, Sync

FloatingWindow "TRANSPORT"
 ┌──────────────────────────────────────────┐
 │ −  TRANSPORT                            ✕ │
 │ [Pause] [⏮] 3.09 [Loop] [Follow] ███████ │   transportw-*
 └──────────────────────────────────────────┘

The scrubber (REQ-the-scrubber-presents-as-a-timeline) — square cells the height of the buttons beside them, on a
near-black bed whose 2px gaps are the dividers. One line; a long song scrolls:

  ┌─────────────────────────────────────────────┐
  │ │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │▓7▓│ 8 │ 9 │10 │11 │→   --tray-top bed, 35px cells
  └─────────────────────────────────────────────┘    ▓ = the global `playing`
```

## Scenarios (BDD)

```gherkin
Scenario: Shift+Space pauses and continues (REQ-shift-space-pauses)
  Given the transport is playing
  When the user presses Shift+Space
  Then the clock pauses, holding its place as the cue
  When the user presses Shift+Space again
  Then the transport continues from that cue
  And a bare Space still toggles Play/Stop
# pinned by: tests/ui/shortcuts.test.ts

Scenario: The Song row and the window carry the same controls (REQ-one-transport-control-builder/REQ-the-song-panel-transport-row)
  Given the Song tab is open
  Then its transport row carries Play/Pause, ⏮, the readout, Loop and the scrubber
  And the header's transport-play is still the only element with that testid
# pinned by: tests/ui/transport-controls.test.ts, e2e/transport-window.spec.ts

Scenario: The launcher opens a floating transport usable off the Song tab
  Given the Song tab is open
  When the user clicks TRANSPORT (transport-open)
  Then a transport-window appears with Play/Pause, ⏮, a readout, Loop and a scrubber
  And switching to another tab leaves it visible and live
# pinned by: e2e/transport-window.spec.ts

Scenario: Neither surface duplicates a header knob (REQ-transport-is-a-floating-window)
  Given the TRANSPORT window is open
  Then it carries no transport.bpm or transport.swing knob
  And the document still holds exactly one of each — the header's
# pinned by: tests/ui/transport-controls.test.ts, e2e/transport-window.spec.ts

Scenario: The window's Play button and the header's stay in sync (REQ-play-pause-is-not-a-second-truth)
  Given the transport is stopped
  When the user clicks the window's Play
  Then the transport starts, the window's button reads Pause and the header's Stop
  When the user clicks the header's Stop
  Then both read Play again
# pinned by: e2e/transport-window.spec.ts

Scenario: Play plays through the header; Pause pauses through the clock (REQ-play-pause-is-not-a-second-truth)
  Given the transport is stopped
  When the user clicks the row's Play
  Then UiBridge.toggleTransport is called and the clock is not touched directly
  When the transport is playing and the user clicks Pause
  Then clock.pause() is called and toggleTransport is not
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Pause resumes from where playback was (REQ-pause-and-stop-are-separate-verbs)
  Given a four-bar chain playing from bar 1
  When the user clicks Pause during bar 3
  Then the transport stops and the readout still reads bar 3
  When the user clicks Play
  Then playback continues from that position, not from bar 1
  And after the header's Stop, the next Play starts from bar 1 again
# pinned by: e2e/transport-window.spec.ts

Scenario: The readout shows the cue while stopped (REQ-the-position-readout-is-bar-dot-step)
  Given a four-bar chain is enabled
  And the transport is stopped and the user seeks to bar 3 step 9
  Then the readout reads 3.09 — where Play will begin
# pinned by: tests/ui/transport-controls.test.ts

Scenario: The readout never counts a bar the song does not have (REQ-the-position-readout-is-bar-dot-step, regression)
  Given no chain lane is enabled, so the song is one repeating bar
  When the transport has played past the end of bar 1
  Then the readout still reads bar 1 — the scrubber has one cell, and the two
    must name the same bar
  And with a three-bar chain enabled, bar 5 reads 2.xx (5 % 3), agreeing with the
    lit cell rather than climbing past the end of the song
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Clicking a scrubber bar jumps the song there (REQ-the-bar-scrubber)
  Given an enabled seq chain of four bars
  When the user clicks the third scrubber cell
  Then the playhead moves to the top of bar 3 and the chain follows
# pinned by: tests/ui/transport-controls.test.ts, e2e/transport-window.spec.ts

Scenario: The scrubber grows and shrinks with the song (REQ-the-bar-scrubber)
  Given no chain lane is enabled
  Then the scrubber shows a single bar
  When a six-bar drum chain is enabled
  Then it shows six, rebuilt once — not on every tick
# pinned by: tests/ui/transport-controls.test.ts

Scenario: A long song scrolls the timeline rather than growing the row (REQ-the-scrubber-presents-as-a-timeline)
  Given a chain longer than the scrubber is wide
  When the transport reaches a bar outside the view
  Then that cell is scrolled back into view, clamped at the origin going left
  And a tick within the same bar writes no scroll position
# pinned by: tests/ui/transport-controls.test.ts

Scenario: A song too long for the window scrolls on the controls' line (REQ-the-scrubber-presents-as-a-timeline, regression)
  Given a 26-bar chain and the TRANSPORT window open
  Then the scrubber sits on the same line as Play/Pause and scrolls
  And with a four-bar chain the scrubber does not scroll and the window is
    narrower than its cap — no empty space beside a wrapped strip
# pinned by: e2e/transport-window.spec.ts

Scenario: The width can be dragged wider, is remembered, and resets to automatic (REQ-the-window-width-is-resizable)
  Given a 64-bar chain and the TRANSPORT window open at its automatic width
  When the user drags transport-window-resize to the right
  Then the window is wider and the scrubber shows more bars
  When the page is reloaded and the window reopened
  Then it opens at the dragged width
  When the user double-clicks the grip
  Then the window is back to its automatic width and nothing is stored
# pinned by: e2e/transport-window.spec.ts

Scenario: A short song has nothing to resize (REQ-the-window-width-is-resizable)
  Given a four-bar chain and the TRANSPORT window open
  Then transport-window-resize is hidden
# pinned by: e2e/transport-window.spec.ts

Scenario: Follow off leaves the timeline where the user scrolled it (REQ-follow-keeps-the-playhead-in-view)
  Given a chain longer than the scrubber is wide and Follow on (the default)
  When the user turns Follow off
  And the transport reaches a bar outside the view
  Then no scroll position is written
  When the user turns Follow back on
  Then the lit cell is scrolled into view at once
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Both surfaces share one Follow (REQ-follow-keeps-the-playhead-in-view)
  Given the Song row and the window are both built
  When the user clicks Follow in one of them
  Then the other's Follow button turns off too
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Transport controls go inert while slaved (REQ-seeking-respects-the-one-guard)
  Given canSeek() is false
  Then ⏮ and the scrubber are marked inert and clicking them moves nothing
# pinned by: tests/ui/transport-controls.test.ts

Scenario: The row carries a help badge on its launcher (REQ-the-transport-row-carries-a-help-badge)
  Given the info badges are on and the Song tab is open
  Then a `transport.song` badge anchors to the TRANSPORT launcher
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts
```

## Tests & verification

- Unit: `tests/ui/transport-controls.test.ts`, `tests/ui/shortcuts.test.ts`
  — `npm test`
- E2E: `e2e/transport-window.spec.ts` — `npm run e2e`
- Dev-bridge assertions: `window.__synth.engine.clock.step` / `.cue` (DEV only)

## Open questions / future

- A **header** entry point would make the window reachable without visiting the
  Song tab first — the same open question [live-fx-window](live-fx-window.md)
  records, and it should be answered for both at once rather than growing two
  header buttons.
- `Arrangement.songBars()` counts the motion lane; [audio export](audio-export.md)
  deliberately still asks only about the three audible lanes, so a motion chain
  longer than every audio chain lengthens the scrubber but not the export. That
  asymmetry is arguably an export bug, but changing export length is its own
  change with its own regression surface.
