# Motion panel (the Motion tab's lanes, pads and graph)

```yaml
id: motion-panel
status: implemented
version: 2
owner: core
related:
  - motion-sequencer      # the machine these controls edit
  - xy-pad
  - step-grid-editing
  - lane-fold             # the fold button, shared with the sequencer
  - dropdown
  - meter
  - ../recipes/design-an-interaction
source:
  - src/ui/panels/motion-panel.ts
  - src/ui/panels/step-panel-scaffold.ts    # lane hooks: bank bar content dot, playhead, Clear ▾
  - src/ui/components/motion-step-pad.ts
  - src/ui/components/motion-graph.ts
  - src/ui/components/value-bubble.ts
  - src/ui/components/lane-fold.ts
  - src/ui/format-param.ts
```

## Background / Why

The [motion sequencer](motion-sequencer.md) owns what a motion bank *means* — the
curve, the writes, the chain lane, the file. This spec owns how it is edited: one XY
lane and four single-param lanes of step pads on the Motion tab, each with a header,
a graph of the curve that will play, and a fold.

## Requirements

- **REQ-each-motion-step-is-a-mini-xy-pad** — Each XY step is a **mini XY pad**: drag
  sets `(x,y)`, double-click/tap clears, and the dot sits at the literal coordinate.
  Commit timing and modifiers are REQ-the-pads-gesture-set-peek-snap-fine. An SVG
  overlay traces the **selected axis** across the cells (view toggle Y/X, default Y,
  local view state). **The pad owns the dot and the graph owns the line**: the overlay
  is a 0–100 `viewBox` with `preserveAspectRatio="none"`, so each anchor's `<circle>`
  draws as a short tick on the line at the cell's *centre*. That is deliberate, not a
  misplaced dot; the pad's dot sits at its *x value*. The line is mode-aware (the
  slide polyline, or a full-width staircase in step mode). It draws the **carry** as
  dashed edge segments at the values REQ-cross-bank-carry will play, resolving
  neighbours from the chain around the edit bank. The geometry is the pure
  `motionGraphPoints(bank, view, mode, neighbours?, cells?)`, whose edges come from
  `valueAt`, so it cannot drift from playback. It redraws on the lane's `slide`,
  chain, assignment and meter changes. Layout, one header per lane over full-width
  cells so step *n* reads vertically:
  - the **machine header**: `motion.on`, BankBar (`bank-motion-*`), undo, `Clear ▾`;
  - the **XY lane header**: the XY Pad launcher (`motion-xypad`), Y/X view toggle,
    Slide/Step, the axis pickers showing the edit bank's *effective* assignment, the
    inherit/reset button and the "graph: `<param>`" hint. An axis with **no override**
    has its picker **dimmed** via `Dropdown.setDimmed`
    ([dropdown](dropdown.md) REQ-a-dropdown-can-be-dimmed), never by dimming the
    root, which would trap the fixed menu behind the pads;
  - a **dashed divider** under the XY lane and a **solid** one under the machine
    header. Track cells use a wider gap.

  Help badges ([info-badges](info-badges.md)
  REQ-info-badges-show-per-control-help/REQ-the-motion-tab-carries-two-lane-badges):
  `motion` on `tab-motion`, `motion.xy` on the XY header, and `motion.tracks` once on
  the A row.

- **REQ-single-param-lanes-below-the-xy-lane** — Each track is a **header row** (the
  fold button carrying the caret and the lane letter, the param dropdown,
  `seg-motion.t<i>.slide`) over full-width **level pads**, one per lane cell (all 16
  built, those past the lane `hidden`). Drag up/down sets the level (fill from the
  bottom) and double-tap clears to the default step. It is the same component as the
  XY pads, so readout, peek, snap and fine apply ([step-grid-editing](step-grid-editing.md)
  REQ-motion-keeps-its-own-gesture). The fill snaps (no CSS animation). Every lane
  shares one `PlayheadHighlighter`, and each draws the same mode-aware line in its own
  mode. A lane with no param renders dimmed with inert pads. The row never goes inert,
  or its picker would be unreachable (ADR-014 law 2). A level pad drops the vertical
  centre line, keeping the horizontal 50 % mark. The bank bar's content dot counts
  every lane ([banks](banks.md) REQ-content-dot-covers-every-lane). `Clear ▾` lists
  **every lane holding steps** ([step-grid-editing](step-grid-editing.md)
  REQ-clear-menu-clears-in-bulk). Axis overrides and track params survive every
  clear.

- **REQ-an-empty-motion-lane-starts-folded** — A track with **no `param` and no set
  steps** starts folded: header kept, cells and graph collapsed
  ([lane-fold](lane-fold.md)).
  - The **param picker stays in the header**, so a folded lane is still assignable.
  - **Picking a parameter unfolds** the lane.
  - **Clearing the param back to none does NOT re-fold it**: the fold is a remembered
    gesture, not a projection, and a collapse under the pointer would steal the next
    pick.
  - The choice persists per lane under `websynth.ui.collapsed.motiontrack.<i>`
    ([lane-fold](lane-fold.md) REQ-a-lane-folds-on-a-stored-preference-first). An
    untouched lane re-derives its default when a bank or song arrives
    ([lane-fold](lane-fold.md) REQ-an-untouched-lane-re-derives-its-default).
  - The XY lane never folds.
  - Four open lanes **scroll** with the page rather than sharing a fixed height, so
    every pad keeps its 64 px.

- **REQ-a-motion-lane-header-carries-its-mute** — Every lane header carries its own
  mute ([motion-lane-mute](motion-lane-mute.md) REQ-each-motion-lane-has-its-own-mute):
  `switch-motion.xy.mute` after the XY lane's Slide/Step, and `switch-motion.t<i>.mute`
  after each track's. It is the drum/seq row's `Switch(bus, id, 'mute')`, so it reads
  and behaves like every other track mute.
  - It lives in the **header**, so a folded lane can still be muted
    ([lane-fold](lane-fold.md) REQ-a-lane-fold-hides-the-body-not-the-header).
  - A muted lane's **body dims** (`.laneMuted`) but stays **editable**: authoring a
    lane before letting it play is the point of muting it. Only an *unassigned* lane
    goes inert (REQ-single-param-lanes-below-the-xy-lane). The dim follows the bus,
    so a mute written by another lane shows too.
  - The lane's param pickers (the track picker, the XY axis pickers) leave out the
    ids `motionTargetAllowed` refuses ([motion-lane-mute](motion-lane-mute.md)
    REQ-a-lane-cannot-target-the-machine-or-itself). The other lanes' mutes are offered.
    A track whose loaded target is refused shows its picker **dimmed**, titled with
    why, so a dead lane never reads as a live one.
  - The Song tab's Motion card keeps only the machine-wide `motion.mute`.

- **REQ-the-ab-lane-repaint-is-gated-on-visibility** — `arrangement.onChange` fires
  every bar, and a lane repaint rebuilds an SVG and re-levels 16 pads. So track
  repaints share the XY graph's visibility gate
  ([runtime-performance](runtime-performance.md) REQ-no-work-for-offscreen-dom): one
  requested while hidden is coalesced into one on reveal (the `graphDirty` idiom).
  Edit-driven repaints go through the same gate.

- **REQ-a-folded-motion-lane-does-no-repaint** — A folded lane repaints its **header**
  and not its body. One body repaint is coalesced onto its unfold, with a per-lane
  flag nested inside the panel's gate. `paintHeader` (picker value, `.trackDim`,
  readout) always runs, since a folded header is on screen
  ([lane-fold](lane-fold.md) REQ-a-lane-fold-hides-the-body-not-the-header). A stale
  "— none —" would let the next pick overwrite a loaded assignment.
  `onMotionTrackChange` emits once per lane (`emitAllMotionTracks`), and the panel
  repaints only the lane named, so a bank switch costs `MOTION_TRACK_COUNT`
  repaints, not its square. Only reveal repaints all.

- **REQ-the-xy-window-axes-follow-motion** — The XY Pad window's axes (labels, dot,
  drag/wheel targets) follow the *effective* assignment: `createEffectiveXy`
  (`state/xy-effective.ts`) resolves the play bank's override per axis while motion is
  active, falling back to `XyPadStore`. It re-resolves on chain moves, override edits,
  base reassignment and `motion.on`/`motion.mute`/`motion.xy.mute`. The pad's gear pickers edit the
  **base** assignment (the store's single writer).

- **REQ-a-motion-steps-value-is-readable-without-hovering** — The value shows in two
  places fed by **one string**, rendered by `applyGesture` from a single call:
  - a **per-lane readout** in the lane header (reserved height, `tabular-nums`),
    following the pointer within its lane (`pointerenter`, or the live gesture) and
    then **sticking** to the last cell, so A's step 5 can be compared against B's;
  - a **floating bubble** above the pad, only while a gesture runs (press, drag, peek).

  The string carries the 1-based zero-padded step number, the normalized value and
  the real value (`fromNorm` + `formatParam`, lifted from `Knob`):

  ```
  level lane          06 · 0.40 · 40%
  XY lane             05 · x 0.25 (1.2kHz) · y 0.80 (80%)
  track with no param —
  ```

  The pad runs on Pointer Events, so touch takes the same path (ADR-014 law 6); hover
  is additive. A gesture always wins over hover.

- **REQ-the-pads-gesture-set-peek-snap-fine** — `MotionStepPad` (XY and level lanes
  alike) has three behaviours, declared separately below for citation. A fired peek
  resets the double-tap latch, so a peek can never become the first half of a clear.

- **REQ-the-pad-write-is-deferred** — A press commits on **release**, so holding reads
  without writing:

  ```
  pointerdown  -> show the readout with the cell's CURRENT value; arm a 350 ms timer
    travel > 6 px      -> drag: write from here on, live
    release < 350 ms   -> tap: write the press-position value
    350 ms, no travel  -> PEEK: readout only; releasing writes nothing
  ```

  The readout always shows the cell's actual value. Long-press means "inspect" as on
  the trigger grids ([step-grid-editing](step-grid-editing.md)
  REQ-hold-to-edit-selects-without-toggling).

- **REQ-a-coarse-pad-drag-snaps** — A coarse drag quantizes to `0.05` on both axes as
  `Math.round(v * SNAP_STEPS) / SNAP_STEPS`. Dividing by the integer makes two lanes
  hold the *identical* double. `0` and `1` stay reachable. This is the touch route to
  repeatable values, and only newly written values are snapped.

- **REQ-shift-drag-is-fine-and-unsnapped** — `Shift`+drag is relative and unsnapped.
  Shift at `pointerdown` **does not jump**: it anchors at the current value. A Shift
  change mid-drag **re-anchors** (the knob's re-division jump must not be inherited),
  and a stroke that went relative stays relative. `FINE_PX = 400` spans 0..1. It is
  desktop-only and an enhancement; snapping gives touch exactness.

- **REQ-the-motion-graph-follows-the-lane** — `motionGraphPoints` /
  `motionGraphPoints1D` take the same `cells` as `scalarAt`: anchor centres at
  `(s + 0.5) / cells`, the trailing edge at the seam, and anchors past `cells` not
  drawn. The panel passes `laneGrid(bus, 'motion').cells` and repaints every lane on
  a meter change, so the drawing and the playing share one grid.

## Technical design

### Gesture inventory

The pad (both lane kinds; [recipe](../recipes/design-an-interaction.md) step 1). `—`
is a decision.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap / click | set `(x,y)` (XY) or the level, **written on release** | Korg Electribe; Kaoss Pad |
| drag | set continuously, snapped to 1/20 | FL Studio, Ableton (draw) |
| long-press ≥ 350 ms | **peek** — show the value, write nothing | Elektron parameter locks; Push step detail |
| Shift + drag | fine: relative, unsnapped, 400 px full travel | this app's knobs |
| double-tap | clear the anchor / reset the level | Electribe |
| hover (mouse) | update **that lane's header readout only** — never the bubble | DAW status-bar readouts |
| right-click | — long-press already reads without writing, and works on a phone | — |
| wheel | — the pad sits in a scrollable panel; a wheel would fight the page | — |
| `Delete` / `⌫` | — no selection cursor ([step-grid-editing](step-grid-editing.md) REQ-motion-keeps-its-own-gesture) | — |

Tap and long-press share a press but split on duration and travel, and the deferred
commit keeps them from both firing (law 2). `wheel` and `right-click` are deliberately
free ([step-grid-editing](step-grid-editing.md) REQ-the-ruler-is-separate-chrome).

The **fold button** is a plain `<button type="button">`:

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap / click | fold or unfold this lane, and remember the answer | the sequencer's track fold |
| `Tab` / `Shift+Tab` | move focus across the lane headers | native |
| `Enter` / `Space` | same as tap | native |
| double-tap | — a second tap toggles back | — |
| long-press / right-click / drag / wheel | — the pads below already own all four | — |
| — | picking a parameter in this lane's picker | Opens the lane: a second route, not a gesture on the button. |

The **lane mute** is the shared `Switch` (a `<button>`), with the same inventory as
every track mute:

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| tap / click | mute or unmute this lane | drum/seq/sampler track mutes; Elektron track mute |
| `Enter` / `Space` | same as tap | native |
| double-tap | — a second tap toggles back | — |
| long-press / right-click / drag / wheel | — nothing to inspect or scrub on a two-state switch | — |

## Scenarios (BDD)

```gherkin
Scenario: Every lane's controls sit above its own cells
  Given the Motion tab is open
  Then the XY Pad launcher, view toggle, Slide/Step, axis dropdowns and the
    "graph:" hint are all in one row ABOVE the XY pads
  And each track's label, param picker and Slide/Step sit above its own cells
  And a single dashed divider separates the XY lane from the tracks
  And a solid divider separates the machine header from the XY lane
# pinned by: e2e/motion.spec.ts

Scenario: An inherited axis picker still opens a readable menu (regression)
  Given a bank with no override, so both axis pickers read as inherited
  When I open the X axis picker
  Then its options render at full opacity, not at the toggle's dimmed alpha
  And the menu paints above the XY pads below it, not behind them
# pinned by: e2e/motion.spec.ts

Scenario: The tracks show the playhead while playing
  Given the Motion tab is open and the transport is running
  When the playhead advances
  Then the playing column lights on the track cells, not only the XY pads
# pinned by: e2e/motion.spec.ts

Scenario: A hidden Motion tab repaints no lane per bar (REQ-the-ab-lane-repaint-is-gated-on-visibility)
  Given the Motion tab is not the active tab
  And the transport is playing
  When the arrangement advances a bar
  Then no track lane rebuilds its graph or re-levels its pads
# pinned by: tests/ui/motion-panel.test.ts

Scenario: A revealed Motion tab shows the current lanes at once (REQ-the-ab-lane-repaint-is-gated-on-visibility)
  Given the Motion tab was hidden while its lanes changed
  When it is revealed
  Then the lanes repaint once, showing the current steps rather than stale ones
  And revealing it again with nothing changed repaints nothing
# pinned by: tests/ui/motion-panel.test.ts

Scenario: The XY lane and the tracks each carry a short help badge
  Given the info badges are on and the Motion tab is open
  Then a `motion.xy` badge anchors to the XY lane header and a `motion.tracks`
    badge anchors to the A track's row, each a short explainer distinct from the
    essay-length `motion` badge on the tab
# pinned by: tests/ui/help-content.test.ts (topic presence)

Scenario: Holding a pad reads its value without changing it (REQ-the-pad-write-is-deferred)
  Given track A step 5 holds 0.40
  When the user presses that cell near its top and holds still for 400ms
  Then the readout shows 0.40 — the value that is THERE, not the press position
  And releasing writes nothing: step 5 still holds 0.40
# pinned by: tests/ui/motion-step-pad.test.ts, e2e/motion.spec.ts

Scenario: A tap still sets the value, on release (REQ-the-pad-write-is-deferred)
  Given track A step 5 is empty
  When the user taps it 25% up from the bottom and releases within 350ms
  Then step 5 is on at 0.25
# pinned by: tests/ui/motion-step-pad.test.ts

Scenario: A drag commits from its first movement (REQ-the-pad-write-is-deferred)
  Given the user presses a pad and moves more than 6px without pausing
  Then the peek never fires and the value tracks the pointer for the rest of the
    stroke
# pinned by: tests/ui/motion-step-pad.test.ts

Scenario: Coarse values land on the same level in both lanes (REQ-a-coarse-pad-drag-snaps)
  Given the user drags track A step 5 and track B step 5 to roughly the same height
  Then both values are multiples of 0.05
  And two drags that land within half a snap step of each other produce the
    IDENTICAL number, which is what makes the lanes match
# pinned by: tests/ui/motion-step-pad.test.ts

Scenario: Shift+drag is fine, and pressing with Shift does not jump (REQ-shift-drag-is-fine-and-unsnapped)
  Given track A step 5 holds 0.40
  When the user presses it near the top with Shift held
  Then the value stays 0.40 — no absolute jump to the press position
  When the user then drags 40px upward with Shift still held
  Then the value rises by about 0.10 (400px spans the full range), unsnapped
# pinned by: tests/ui/motion-step-pad.test.ts

Scenario: Releasing Shift mid-drag re-anchors instead of jumping (REQ-shift-drag-is-fine-and-unsnapped)
  Given a fine drag in progress
  When Shift is released and the pointer moves on
  Then the value continues from where it was, at coarse sensitivity
  And it does not jump to the pointer's absolute position
# pinned by: tests/ui/motion-step-pad.test.ts

Scenario: The value is visible while dragging, on touch as well (REQ-a-motion-steps-value-is-readable-without-hovering)
  Given the Motion tab is open
  When the user drags track A step 5
  Then a bubble above the pad and the A lane's header readout both show the same
    string, carrying the step number, the normalized value and the real parameter
    value
  When the user lifts off
  Then the bubble is gone and the header readout stays, still naming step 5
# pinned by: tests/ui/value-bubble.test.ts, e2e/motion.spec.ts

Scenario: A lane with no parameter has nothing to convert (REQ-a-motion-steps-value-is-readable-without-hovering, edge)
  Given track B has no parameter chosen
  Then its readout shows "—" rather than a bare normalized number
# pinned by: e2e/motion.spec.ts

Scenario: An empty lane arrives folded and picking a param opens it (REQ-an-empty-motion-lane-starts-folded)
  Given no stored fold preference and the Motion tab open
  Then lanes with no param and no steps are folded, and their cells are not shown
  And each folded lane's param picker is still in the DOM and still usable
  When a param is chosen on a folded lane
  Then that lane unfolds
# pinned by: tests/ui/motion-panel.test.ts, e2e/motion.spec.ts

Scenario: Clearing a lane's param leaves it open (REQ-an-empty-motion-lane-starts-folded)
  Given an open lane with a param chosen
  When the param is set back to none
  Then the lane stays open, so the next param can be picked in the same place
# pinned by: tests/ui/motion-panel.test.ts

Scenario: Each lane header carries its own mute (REQ-a-motion-lane-header-carries-its-mute)
  Given the Motion tab is open
  Then the XY lane header holds switch-motion.xy.mute and each track header its
    switch-motion.t<i>.mute
  When lane B is folded
  Then its mute switch is still in its header and still toggles motion.t1.mute
  When motion.t1.mute is set — by the switch or by another lane writing it
  Then lane B's body is dimmed and its pads still take an edit
# pinned by: tests/ui/motion-panel.test.ts, e2e/motion.spec.ts

Scenario: A loaded lane aimed at a refused target reads as dead (REQ-a-motion-lane-header-carries-its-mute)
  Given a song assigns lane A its own mute, motion.t0.mute
  Then lane A's picker shows it dimmed, with a title naming the param
  And picking another lane's mute or a sound param clears the dim
# pinned by: tests/ui/motion-panel.test.ts

Scenario: A lane's picker offers the other lanes' mutes but not its own (REQ-a-motion-lane-header-carries-its-mute)
  Given the Motion tab is open
  Then lane A's param picker offers motion.t1.mute and motion.xy.mute
  And it offers neither motion.t0.mute, motion.on nor motion.mute
  And the XY axis pickers do not offer motion.xy.mute
# pinned by: tests/ui/motion-panel.test.ts

Scenario: A song that uses lanes C and D does not arrive with them hidden (REQ-an-empty-motion-lane-starts-folded)
  Given lanes C and D are folded by default, with no stored preference
  When a song is loaded that assigns and fills them
  Then both lanes are open
  And a lane the user had folded by hand stays folded
# pinned by: tests/ui/motion-panel.test.ts

Scenario: A folded lane repaints nothing and catches up on unfold (REQ-a-folded-motion-lane-does-no-repaint)
  Given the Motion tab is showing and a lane is folded
  When the arrangement advances a bar, or the lane's steps change
  Then that lane rebuilds no graph and re-levels no pads
  When it is unfolded
  Then it repaints exactly once, showing the current steps rather than stale ones
# pinned by: tests/ui/motion-panel.test.ts

Scenario: A folded lane's header still tracks the store (REQ-a-folded-motion-lane-does-no-repaint)
  Given a lane the user folded by hand, so a song load leaves it folded
  When a song arrives that assigns that lane a parameter
  Then the lane stays folded
  But its param picker reads that parameter, and the row is no longer dimmed
# pinned by: tests/ui/motion-panel.test.ts

Scenario: A per-lane change repaints that lane only (REQ-a-folded-motion-lane-does-no-repaint)
  Given all four lanes are open and the Motion tab is showing
  When one lane's steps change, or a bank switch emits once per lane
  Then each emission repaints the lane it names, not all four
  And a bank switch therefore costs MOTION_TRACK_COUNT lane repaints, not its square
# pinned by: tests/ui/motion-panel.test.ts

Scenario: Step mode graphs as a square line
  Given anchors at steps 2 and 10 and step mode
  When the graph is drawn
  Then the line is a full-width staircase: the last anchor's value holds from the
    bar start to step 2 (wrap), jumps there, holds to step 10, jumps, holds to the end
  And in slide mode the same anchors draw the plain anchor-to-anchor polyline
# pinned by: tests/ui/motion-graph.test.ts

Scenario: The graph is drawn on the lane's cells, not the bank's 16 (REQ-the-motion-graph-follows-the-lane, regression)
  Given motion.len is 9 and the XY lane has anchors on steps 1, 5 and 9
  When the graph is drawn
  Then the anchor points sit at the centres of cells 1, 5 and 9 of the NINE the grid
    draws — the step-5 anchor's staircase edge over its own pad, not over step 3
  And an anchor on a step past the lane's length is not drawn at all, matching the
    curve that cannot see it (REQ-the-automation-lane-follows-the-meter)
  And changing motion.len, motion.rate or the meter repaints every lane
# pinned by: tests/ui/motion-graph.test.ts, tests/ui/motion-panel.test.ts

Scenario: The graph draws the bar-line carry (REQ-each-motion-step-is-a-mini-xy-pad)
  Given the chain plays D → A and bank D is on screen
  When the graph is drawn
  Then dashed segments join the bar edges to D's outer anchors at the values that
    will play, and they are flat when the neighbour cannot be carried to
# pinned by: tests/ui/motion-graph.test.ts
```

## Tests & verification

- `tests/ui/{motion-step-pad,motion-graph,motion-panel,lane-fold,value-bubble,format-param}.test.ts`,
  `e2e/motion.spec.ts`.
- **By hand**: on a fresh profile lanes A–D arrive folded; four open lanes scroll at
  phone width. Feel: snap steps cleanly, Shift never jumps, the bubble never covers
  the pad, readouts stay legible at phone width.
