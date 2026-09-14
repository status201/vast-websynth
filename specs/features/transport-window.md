# TRANSPORT window (Song-panel transport section)

```yaml
id: transport-window
status: implemented
version: 5  # v5: Play/Pause on BOTH surfaces (REQ-5/REQ-13) and a Loop button
            #     (transport-loop.md); `compact` is gone (REQ-1)
            # v4: `bar.step` counts the song's bar, not a fixed 16 (REQ-12)
            # v3: the readout wraps at song length — it no longer counts bars the
            #     song does not have (REQ-6)
owner: core
related:
  - transport
  - transport-position
  - typography          # REQ-6's mono readout generalises there (REQ-3)
  - floating-window
  - live-fx-window
  - song-mode
  - arrangement
  - midi-clock-sync
  - onboarding
  - transport-loop      # v5: the Loop button + scrubber picks this row carries
source:
  - src/ui/components/transport-controls.ts   # shared builder + window launcher
  - src/ui/panels/song-panel.ts               # hosts the compact row
  - src/ui/components/floating-window.ts      # the host window
  - src/audio/transport/arrangement.ts        # songBars — how long the scrubber is
```

## Background / Why

[transport-position](transport-position.md) gives every machine tab a ruler for
the 16th **within a bar**. What it cannot show is the song: with an `A A B A`
chain you still cannot see which bar of four you are on, or jump to bar 3
directly. The Song tab is where the chain lanes live, so that is where a
song-scale transport belongs.

It follows [live-fx-window](live-fx-window.md) exactly, for the same reason that
feature exists: transport controls are useless if they are only reachable on one
tab. A launcher opens a non-modal [FloatingWindow](floating-window.md) that, like
every floating window, mounts on `document.body` and therefore keeps working
while you edit a patch on the Synth tab.

Until v5 it differed from LIVE FX in one deliberate way: the Song-panel row was
**compact**, with Play/Stop only in the window, to keep the tallest tab in the app
short. v5 gives the row the **same full control set** as the window, as LIVE FX
does. The row gained **Play/Pause** (the one transport verb nothing else on screen
offers) and **Loop** ([transport-loop](transport-loop.md)), and a row with both,
sitting right against the chains they act on, is the reason to open the Song tab.
The row still wraps rather than growing a second strip, so the height cost is
two buttons' width.

**BPM and SWING are not here, on either surface.** They are permanently in the
header, they are set once per song rather than performed, and a second pair
bought no reach — only height, in the one window whose whole point is to be
small. The duplicate was also a *silent disagreement*: the header's BPM knob is
disabled while the transport is slaved to an external clock
([midi-clock-sync](midi-clock-sync.md) REQ-14) and this copy was not, so it
stayed writable in the one state where BPM is not the user's to set. Two
controls for one param where only one of them shows that the param is locked is
[ADR-014](../decisions/adr-014-dont-make-me-think.md) law 5 (state is visible)
failing; deleting the copy fixes it without a second `setDisabled` wiring to
keep in step.

## Requirements

- **REQ-1** — **Shared builder.** `buildTransportControls(engine, bridge,
  opts?)` renders the transport control set from one source; `opts.testIdPrefix`
  namespaces every testid so two instances coexist (the Song row uses
  `transport`, the window `transportw`), the same mechanism
  [live-fx-window](live-fx-window.md) REQ-1 uses. (v5) Both surfaces render the
  **same** controls. The `opts.compact` flag, which dropped Play/Stop from the
  Song-panel row, was removed together with the difference it expressed.

- **REQ-2** — **TRANSPORT floating window.** A launcher (`transport-open`)
  toggles a `FloatingWindow` titled **TRANSPORT** (`testId: transport-window`),
  built lazily on first open and kept alive across closes. Contents in order
  (v5): Play/Pause, ⏮ return-to-start, the `bar.step` readout, Loop, the bar
  scrubber. It
  takes no `ParamBus` — **neither surface mints a second `transport.bpm` or
  `transport.swing` knob** (see *Background*); the header's are the only ones.

- **REQ-3** — **The launcher doubles as the section title**, leading the Song
  panel's transport row and carrying the same ❐ "opens a new window" glyph as
  the LIVE FX launcher (aria-hidden; the button's `aria-label` carries the
  meaning). No separate text label — that is the space this feature gives back.

- **REQ-4** — **Song-panel row** (v5: no longer compact):
  `[TRANSPORT ❐] [Play/Pause] [⏮] [bar.step] [Loop] [bar scrubber]`, placed **directly under the four
  machine lanes and above Live FX**. The scrubber is one cell per chain slot, so
  it reads as a ruler for the chains immediately above it — a bar number in the
  scrubber and a chip in a lane mean the same bar. Sitting it down by Sync (its
  first home) put the position readout at the bottom of the tallest panel in the
  app, several sections away from the only thing that gives it meaning.

- **REQ-5** — **Play/Pause is not a second source of truth.** (v5: was Play/Stop.)
  Stopped, a click **plays** through `UiBridge.toggleTransport`, which clicks the
  *real* header button. That way it gets the
  [empty-play hint](empty-play-hint.md) intercept and the
  [Play-button blink](play-button-blink.md) state machine without extra code, and
  starts from `clock.cue`, which is the resume point after a pause. Playing, a
  click **pauses** through `clock.pause()` ([transport](transport.md) REQ-12).
  Pause cannot go through the header, whose click means *stop*, and it needs
  neither the hint (stops are never intercepted) nor the blink wiring (driven by
  `onStop`). The label and `.on` follow `clock.onStart`/`onStop`, exactly as the
  header button's do, so all three buttons always agree about whether the
  transport is running.

- **REQ-6** — **Position readout.** `bar.step`, 1-based (bar 1 step 1 at the
  top). Playing, it shows the live step; stopped, the **cue** — where Play will
  begin — matching the machine-tab rulers
  ([transport-position](transport-position.md) REQ-9), so the two surfaces can
  never disagree about "where are we?".
  **The bar wraps at song length** (v3): it is the *same* `bar % bars` value that
  lights the scrubber cell (REQ-7), computed once and used for both, so the
  number and the lit cell cannot drift apart. v1 printed the absolute bar, so a
  one-bar song — the default, with no chain lane enabled — counted
  `1.01, 2.01, 3.01 … 37.01` beside a single lit cell labelled `1`: the readout
  inventing bars the song does not have, which
  [transport-position](transport-position.md) REQ-15 had already ruled out for
  the machine-tab rulers and which
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 5 forbids (what is on
  screen must be what is true). The step term is untouched — it is the 16th
  within the bar and has always wrapped.
  It is set in a **monospaced** face
  (`--mono`), so it moves only when the digit *count* changes (bar 9 → 10) and
  never step to step. `--serif` (Georgia) ships proportional old-style figures
  and carries no `tnum` feature, so `font-variant-numeric: tabular-nums` bought
  nothing there and the readout wiggled on every 16th.

- **REQ-7** — **Bar scrubber.** One cell per bar of the song, current bar lit,
  click to seek to the top of that bar. Song length is
  `Arrangement.songBars()` — the longest **enabled** chain lane across all four
  lanes — falling back to a single bar when no lane is enabled. The DOM is
  rebuilt only when that length changes; the lit class moves in place otherwise,
  the same split-rendering rule the chain chips already follow.

- **REQ-8** — **Seeking respects the one guard.** Both the ⏮ and the scrubber go
  through `StudioApi.seekTo`, and both surfaces mark themselves inert when
  `canSeek()` is false ([transport-position](transport-position.md) REQ-6/REQ-8).

- **REQ-9** — **The chain chips are left alone.** A chip click already toggles
  the edit selection that ◀ ▶ ✕ act on ([song-mode](song-mode.md)); adding a
  seek to it would give one gesture two outcomes, which
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 forbids. The
  scrubber is a separate target sitting above them.

- **REQ-10** — **The row carries a help badge** on its launcher — which is also
  its section title, so the badge sits on the row's leading control. Topic
  `transport.song` ([onboarding](onboarding.md) REQ-16): the `bar.step` readout,
  the scrubber's one-cell-per-chain-slot correspondence, what the floating
  window adds, and the states where seeking is refused (REQ-8). (v5) It also
  covers Play/Pause against the header's Play/Stop (REQ-13) and Loop
  ([transport-loop](transport-loop.md) REQ-13).

- **REQ-11** — **The scrubber presents as a timeline, not a row of links.**
  Square cells (no border radius) the height of the buttons beside them, sitting
  on a near-black bed whose gaps read as the segment dividers between bars — the
  transport strip of a DAW ([ADR-014](../decisions/adr-014-dont-make-me-think.md)
  law 4, follow precedent), not a paginator. It is **one line**: a song longer
  than the row scrolls horizontally rather than wrapping into a block, so the
  row's height is the same for a 4-bar song and a 64-bar one. The lit cell is
  scrolled back into view when it leaves it — computed on the scroller's own
  `scrollLeft` (never `scrollIntoView`, which may scroll the page too), inside
  the same *bar changed* guard as the lit class, so it costs nothing per tick
  ([runtime-performance](runtime-performance.md)). The cells carry **no CSS
  transition**: the lit class moves under the playhead, so a cross-fade would
  repaint two cells for the length of the fade after every move while conveying
  nothing the instant swap does not — an animation that costs paints without
  serving the user is a defect, not polish.

- **REQ-12** (v4) — **`bar.step` counts the song's bar.** Both halves of the
  readout, the scrubber's per-bar seek and the bar-cell lighting measure with
  `barTicks` rather than a fixed 16 ([meter](meter.md) REQ-6) — so in 3/4 the
  step half runs 01..12 and bar 2 begins at tick 12. REQ-6's wrap-at-song-length
  rule is unchanged and still applies on top.

- **REQ-13** (v5) — **Pause and Stop are separate verbs, with one of each on
  screen.** The header keeps **Play/Stop** and the Space bar still toggles it:
  Stop means "back to the cue". The song transport's button is **Play/Pause**:
  Pause means "stay here" ([transport](transport.md) REQ-12). Neither button
  changes meaning with state. Each does one thing when the transport runs and
  one when it does not (law 2), and each label names what a click will do. After a
  pause, the readout and the rulers' cue ring show the resume point, since that
  is `clock.cue` (REQ-6); pressing the header's Play also resumes there. The button
  is wide enough for "Pause", so the row does not shift when the label changes.
  Precedent: Elektron's PLAY, which pauses and resumes, sits beside its STOP.
  The MPC has PLAY and PLAY START.

- **REQ-14** (v5) — **Loop lives on this row.** Between the readout and the
  scrubber, because its picks land on the scrubber. The button, the picking mode
  and the range drawn on the cells are specified in
  [transport-loop](transport-loop.md). This spec owns only where it sits and that
  both surfaces carry it (REQ-1).
## Technical design

### Contract / public interface

```yaml
buildTransportControls(engine, bridge, opts?): HTMLElement[]
  # opts: { testIdPrefix?: string (default 'transport') }   # v5: no `compact`
  # [Play/Pause, ⏮, readout, Loop, scrubber]
  # testids: `${p}-toggle`, `${p}-tostart`, `${p}-readout`, `${p}-loop` (v5),
  #          `${p}-scrub`, `${p}-scrub-<bar>`
  # NOT `${p}-play`: the header's own Play button is `transport-play`, and a
  # default-prefixed instance would mint a duplicate of it.
  # NO ParamBus: it owns no params, so it cannot duplicate a header knob (REQ-2).

createTransportWindowLauncher(engine, bridge): HTMLButtonElement
  # the `transport-open` toggle; owns the TRANSPORT FloatingWindow lazily

Arrangement:                                  # src/audio/transport/arrangement.ts
  songBars(lanes?): number    # longest ENABLED lane length; 0 when none enabled.
                              # `lanes` narrows which lanes count — the scrubber
                              # asks about all four, audio export about the three
                              # audible ones (audio-export.md REQ-2 unchanged).
```

### Layer touchpoints & ordering

```yaml
song-panel: transport row = createTransportWindowLauncher(engine, bridge)
  -> buildTransportControls(engine, bridge)          # v5: same set as the window
  section order: chain lanes -> TRANSPORT -> Live FX -> Song I/O -> Audio -> Sync
  (REQ-4: it belongs against the chains it scrubs, not against Sync)
window body: buildTransportControls(engine, bridge, { testIdPrefix:'transportw' })
play: UiBridge.toggleTransport -> the header button's click (REQ-5) — never
  clock.toggle() directly, or the empty-play hint and the LED blink are bypassed
pause (v5): clock.pause() — only ever while playing, so it can never stand in
  for the header's Stop
loop (v5): StudioApi.loop — see transport-loop.md
seek: StudioApi.seekTo only (REQ-8)
repaint: clock.onTick / onSeek / onStart / onStop for the readout + scrubber lit
  class; arrangement.onChange for the scrubber's structure
```

`buildTransportControls` takes the `UiBridge` because REQ-5 forbids it owning a
transport toggle of its own — that is the same seam `shortcuts.ts` uses to drive
Play from the space bar.

### Persistence

Nothing. The window's open state and position are ephemeral, as with every
[floating window](floating-window.md).

## Visual aids

```
Song panel, top down — the transport row sits against the chains it scrubs
(REQ-4), so a scrubber cell and a chain chip name the same bar:

  ┌ SEQUENCER ┐ ┌ DRUMS ┐ ┌ SAMPLER ┐ ┌ MOTION ┐
  │ A A B A   │ │ …     │ │ …       │ │ …      │   the four lane cards
  └───────────┘ └───────┘ └─────────┘ └────────┘
  [TRANSPORT ❐] [Play] [⏮] 3.01 [Loop] ▏1▕2▕3▕4▏  <- this row
   transport-open -toggle -tostart -readout -loop -scrub-<bar>
  [LIVE FX ❐] [DJ FLT] [Fill] [Stutter] …          Live FX, then Song I/O,
                                                    Audio, Sync

FloatingWindow "TRANSPORT"
 ┌──────────────────────────────────────────┐
 │ −  TRANSPORT                            ✕ │
 │ [Pause] [⏮] 3.09 [Loop] ██████████████  │   transportw-*
 └──────────────────────────────────────────┘

The scrubber (REQ-11) — square cells the height of the buttons beside them, on a
near-black bed whose 2px gaps are the dividers. One line; a long song scrolls:

  ┌─────────────────────────────────────────────┐
  │ │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │▓7▓│ 8 │ 9 │10 │11 │→   #0c0905 bed, 35px cells
  └─────────────────────────────────────────────┘    ▓ = the global `playing`
```

## Scenarios (BDD)

```gherkin
Scenario: The Song row and the window carry the same controls (v5, REQ-1/REQ-4)
  Given the Song tab is open
  Then its transport row carries Play/Pause, ⏮, the readout, Loop and the scrubber
  And the header's transport-play is still the only element with that testid
# pinned by: tests/ui/transport-controls.test.ts, e2e/transport-window.spec.ts

Scenario: The launcher opens a floating transport usable off the Song tab
  Given the Song tab is open
  When the user clicks TRANSPORT (transport-open)
  Then a transport-window appears with Play/Pause, ⏮, a readout, Loop and a scrubber
  And switching to the Synth tab leaves it visible and live
# pinned by: e2e/transport-window.spec.ts

Scenario: Neither surface duplicates a header knob (REQ-2)
  Given the TRANSPORT window is open
  Then it carries no transport.bpm or transport.swing knob
  And the document still holds exactly one of each — the header's
# pinned by: tests/ui/transport-controls.test.ts, e2e/transport-window.spec.ts

Scenario: The window's Play button and the header's stay in sync (REQ-5)
  Given the transport is stopped
  When the user clicks the window's Play
  Then the transport starts, the window's button reads Pause and the header's Stop
  When the user clicks the header's Stop
  Then both read Play again
# pinned by: e2e/transport-window.spec.ts

Scenario: Play plays through the header; Pause pauses through the clock (v5, REQ-5)
  Given the transport is stopped
  When the user clicks the row's Play
  Then UiBridge.toggleTransport is called and the clock is not touched directly
  When the transport is playing and the user clicks Pause
  Then clock.pause() is called and toggleTransport is not
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Pause resumes from where playback was (v5, REQ-13)
  Given a four-bar chain playing from bar 1
  When the user clicks Pause during bar 3
  Then the transport stops and the readout still reads bar 3
  When the user clicks Play
  Then playback continues from that position, not from bar 1
  And after the header's Stop, the next Play starts from bar 1 again
# pinned by: e2e/transport-window.spec.ts

Scenario: The readout shows the cue while stopped (REQ-6)
  Given a four-bar chain is enabled
  And the transport is stopped and the user seeks to bar 3 step 9
  Then the readout reads 3.09 — where Play will begin
# pinned by: tests/ui/transport-controls.test.ts

Scenario: The readout never counts a bar the song does not have (REQ-6, regression)
  Given no chain lane is enabled, so the song is one repeating bar
  When the transport has played past the end of bar 1
  Then the readout still reads bar 1 — the scrubber has one cell, and the two
    must name the same bar
  And with a three-bar chain enabled, bar 5 reads 2.xx (5 % 3), agreeing with the
    lit cell rather than climbing past the end of the song
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Clicking a scrubber bar jumps the song there (REQ-7)
  Given an enabled seq chain of four bars
  When the user clicks the third scrubber cell
  Then the playhead moves to the top of bar 3 and the chain follows
# pinned by: tests/ui/transport-controls.test.ts, e2e/transport-window.spec.ts

Scenario: The scrubber grows and shrinks with the song (REQ-7)
  Given no chain lane is enabled
  Then the scrubber shows a single bar
  When a six-bar drum chain is enabled
  Then it shows six, rebuilt once — not on every tick
# pinned by: tests/ui/transport-controls.test.ts

Scenario: A long song scrolls the timeline rather than growing the row (REQ-11)
  Given a chain longer than the scrubber is wide
  When the transport reaches a bar outside the view
  Then that cell is scrolled back into view, clamped at the origin going left
  And a tick within the same bar writes no scroll position
# pinned by: tests/ui/transport-controls.test.ts

Scenario: Transport controls go inert while slaved (REQ-8)
  Given canSeek() is false
  Then ⏮ and the scrubber are marked inert and clicking them moves nothing
# pinned by: tests/ui/transport-controls.test.ts

Scenario: The row carries a help badge on its launcher (REQ-10)
  Given the info badges are on and the Song tab is open
  Then a `transport.song` badge anchors to the TRANSPORT launcher
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts
```

## Tests & verification

- Unit: `tests/ui/transport-controls.test.ts` — `npm test`
- E2E: `e2e/transport-window.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
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
