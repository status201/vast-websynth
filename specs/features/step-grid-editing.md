# Step-grid editing (the shared gesture model)

```yaml
id: step-grid-editing
status: implemented
version: 12
owner: core
related:
  - architecture
  - runtime-performance
  - transport-position
  - ../decisions/adr-014-dont-make-me-think
  - ../recipes/design-an-interaction
  - sequencer
  - drum-machine
  - sampler
  - motion-sequencer
  - step-settings
  - pattern-undo
  - banks
  - meter
  - toast
  - knob-keyboard-access
source:
  - src/ui/components/grid-gestures.ts    # the one gesture controller
  - src/ui/components/clear-menu.ts       # the Clear ▾ header control
  - src/ui/components/gesture-timing.ts   # the double-tap / hold windows, in one place
  - src/ui/panels/step-panel-scaffold.ts  # wires both into every machine tab
  - src/ui/panels/seq-panel.ts
  - src/ui/panels/drum-panel.ts
  - src/ui/panels/sampler-panel.ts
  - src/ui/panels/motion-panel.ts
  - src/ui/shell/pattern-row.ts  # drives every gate from onViewChange
  - src/state/patterns.ts        # bulk clear + rotate entry points
```

The interaction contract every step grid obeys: how a step is created, selected,
edited and deleted. A **cross-cutting facility**: the machine specs say *what their
steps mean*, this one says *how the user touches them*, and they reference it.

## Background / Why

A single click must not do two jobs. Selecting a lit step to edit it must not switch
it off (ADR-014 law 2). So **tap = toggle** stays, as decades of drum-machine muscle
memory (law 4), and selection gets its own gesture. Two already-learned gestures join
it: **paint-drag** (FL Studio, Ableton, Logic) and **hold-to-edit** (Elektron
parameter locks, Push step detail). Bulk deletion is one menu item with one undo, not
128 clicks.

## Requirements

- **REQ-tap-toggles-a-step** — A tap/click inverts `on` and moves the selection cursor
  to the step. The cursor must be **visible on every cell**, including a lit red
  beat-column cell (the same accent-secondary ring), since the edit row and `Delete`
  act on it. **A cancelled pointer writes nothing**: `pointercancel` (a notification
  pull-down, an edge swipe, palm rejection) tears the stroke down with no toggle and
  no paint. Routing it to the release path would read as "neither drag nor hold, so a
  tap" and flip a step on a phone. `chip-reorder.ts` follows the same rule. The cursor
  stays where the press moved it; selection is not a write.
- **REQ-toggling-off-is-non-destructive** — Switching off clears only `on`; `note` /
  `velocity` / `gate` / `prob` / `ratchet` / `tie` / `micro` (and motion's `x`/`y`) are
  kept. The cell keeps its label and stays selected. That is what makes a tap safe.
- **REQ-hold-to-edit-selects-without-toggling** — A press held ≥ 350 ms without
  leaving the cell selects and does **not** toggle. Travel beyond 6 px cancels it, and
  it suppresses the tap on release. **Right-click** (`contextmenu`, default prevented)
  is the desktop alias, never the only route.
- **REQ-drag-paints-steps** — A drag applies one **paint value**, latched at press as
  `!first.on`, to every cell it enters. Pressing a lit cell erases the run, and a dead
  one fills it. A cell already at the value is left alone, so re-crossing never
  flickers. Painting stays in the grid it started in, and is not confined to one row
  on the drum/sampler grids.
- **REQ-delete-clears-the-selected-step** — `Delete` / `Backspace`, while the
  machine's tab is visible, switches the selected step off (non-destructively). It is
  scoped like the tab-scoped `Ctrl+Z` ([pattern-undo](pattern-undo.md)) and ignored in
  a text input.
- **REQ-clear-menu-clears-in-bulk** — Every machine header carries `Clear ▾`: **Clear
  bank** (every row of the edit bank) plus **row** items, rebuilt **on every open**.
  Cursor machines (seq / drum / sampler) offer the selected row; **Motion**, which has
  no cursor, lists its lanes (`XY`, `A`–`D`). **An empty row is not offered** on any
  machine (ADR-014 law 1). Each row *declares* `hasContent` and `clearMenuFor` filters
  centrally, so a new machine inherits the rule. "Content" matches what the item
  destroys: steps, or steps **or a loaded sample** on the sampler
  ([sampler](sampler.md) REQ-clear-ejects-the-slot). The bank item is never filtered,
  so the menu is never empty. Each item is one `PatternStore` call emitting **one**
  bulk mutation. There is no confirmation dialog, since the action is labelled and
  instantly reversible (law 3). **An item destroys everything its label names**: the
  sampler row, labelled with the filename, ejects the sample too, and supplies its own
  `undo`. Bank items never reach past steps.
- **REQ-one-bulk-action-one-undo-entry** — Bulk clears reuse the whole-bank kinds
  (`seq-copy` / `drum-copy` / `sampler-copy` / `motion-copy`), whose `before` clones the
  bank. They never emit N per-cell mutations. The undo stack carries **steps only**, so
  a row that clears more provides `ClearRow.undo`. That *replaces* the toast's default
  `undo.undo(lane)`, and the row calls the lane undo only when the store pushed
  something; otherwise it would pop the user's previous edit.
- **REQ-a-bulk-clear-reports-itself** — A bulk clear shows a [toast](toast.md) naming
  what was cleared, with **Undo** wired to the machine's `PatternUndo`.
- **REQ-motion-keeps-its-own-gesture** — Motion cells are mini XY pads where a press
  *is* a value. So tap / hold / paint do not apply: drag-to-set and double-tap-to-clear
  stay ([motion-sequencer](motion-sequencer.md) REQ-each-motion-step-is-a-mini-xy-pad).
  Hold carries the same *meaning*, inspect without disturbing: the pad's commit is
  deferred ([motion-sequencer](motion-sequencer.md)
  REQ-the-pads-gesture-set-peek-snap-fine), so a held press reads the value. Motion
  takes the Clear menu, single-entry undo and the toast. **`Delete` does not reach
  it**: with no cursor it would act on invisible "last touched" state (law 5), and
  double-tap already clears one anchor. A cleared bank keeps its axis override.
- **REQ-one-grid-gesture-controller** — One controller, `attachGridGestures`, wired
  from `step-panel-scaffold.ts`. A new machine or track inherits the whole set.
- **REQ-grid-gestures-have-touch-parity** — Pointer Events throughout, so finger and
  mouse share a path. Nothing is hover-only. The hold window and slop let a scroll that
  starts on a cell scroll rather than paint.
- **REQ-an-offscreen-grid-repaints-nothing** — `TabContainer` hides inactive panels
  with a class, so all stay mounted. Each panel owns a `VisibilityGate`, driven from
  the one `tabs.onViewChange` in `buildPatternRow`. `wirePlayhead` and the Motion
  graph skip work while hidden, and a folded pattern row hides every panel. **The
  reveal contract**: a tab revealed mid-playback shows the step playing *now* (the
  playhead replays the latest step on `whenShown`, and Motion coalesces its redraws).
  A gate starts `shown`, since panels exist before the `TabContainer`
  ([runtime-performance](runtime-performance.md) REQ-no-work-for-offscreen-dom).
- **REQ-the-ruler-is-separate-chrome** — The trigger-grid cell gestures are
  **saturated**, so "move the playhead" is its own strip **above** the grid
  ([transport-position](transport-position.md)
  REQ-a-position-ruler-above-every-grid), where a click is unambiguously a seek. It is
  never painted or selected, `Delete` and `Clear ▾` never reach it, and it obeys the
  same gate and reveal contract.
- **REQ-cells-past-the-lane-length-are-hidden** — The column count follows the meter
  ([meter](meter.md) REQ-cells-beyond-the-length-are-hidden), so a 3/4 song shows 12
  columns, not 16 with four dead ones. The cells are `hidden`, not removed: DOM, cursor
  and stored steps are untouched, and hidden cells take no gestures.
- **REQ-shift-rotates-the-played-window** — `Clear ▾` ends with **Shift bank X left /
  right** (`clear-<lane>-shift-left` / `-right`) on the seq, drum and sampler grids.
  A shift **rotates** every row of the edit bank one cell, so two opposite shifts
  restore it.
  - It rotates **the played window** (`laneCells()` from `laneGrid`), not all 16.
    Cells past the window are untouched.
  - **The whole step moves**, settings and micro included, copied into the existing
    step objects (as `copySeqBank` does).
  - It is **one bulk mutation** with one toast (`Shifted bank A right`, Undo).
  - A bank with nothing on in the window shifts nothing and reports nothing.
  - It lives in `Clear ▾` because it is a whole-bank edit with the same Undo contract,
    and the header has no room. Motion is excluded: its anchors carry across the bar
    line ([motion-sequencer](motion-sequencer.md) REQ-cross-bank-carry), so "one cell
    later" means something else there.
- **REQ-a-trigger-grid-is-reachable-by-keyboard** — On the drum and sampler grids the
  selection cursor (`GridCursor`) owns focus, as a focused knob does
  ([knob-keyboard-access](knob-keyboard-access.md) REQ-the-keys-a-focused-knob-owns):
  - **one Tab stop per grid** (roving `tabIndex`), following the selection;
  - **arrows** move selection and focus; left/right stop at the played window.
    **Home / End** go to the row's first / last played cell;
  - **Enter** toggles through the same `onToggle` as a tap;
  - each is `preventDefault` + `stopPropagation`, and **every other key passes**:
    Space still plays/stops, Delete still clears, Shift+arrows still seek, letters
    still play notes;
  - a cell's `aria-label` names its row, step and state, written on change. The focus
    ring is `:focus-visible` only.

  The sequencer grid keeps its own cursor and is not covered.

## Technical design

### Gesture inventory

"Trigger grids" = seq / drum / sampler ([recipe](../recipes/design-an-interaction.md)
step 1).

| Gesture | Trigger grids | Motion grid | Precedent |
| --- | --- | --- | --- |
| tap / click | toggle `on` + select | set `(x,y)` anchor, on release | TR-808; Electribe |
| drag | paint `!first.on` | set `(x,y)` continuously | FL Studio, Ableton |
| long-press ≥ 350 ms | **select only** | **peek** — read the value, write nothing | Elektron, Push |
| Shift + drag | — | fine, relative, unsnapped | this app's knobs |
| right-click | select only | — | — |
| double-tap | — (tap already toggles) | clear the anchor | Electribe |
| wheel | ±1 semitone per notch (seq only, by distance, [wheel-steps](wheel-steps.md)) | — | — |
| `Delete` / `Backspace` | clear the selected step | — (no selection cursor) | DAW piano roll |
| arrows / Home / End / Enter | move the cursor / toggle (drum + sampler) | — | grid widgets |
| `Clear ▾` → bank | clear the edit bank | clear the edit bank | — |
| `Clear ▾` → row | clear the selected row | clear a named lane (XY/A–D) | — |
| `Clear ▾` → shift | rotate the played window one cell | — | DAW nudge |
| pointer **cancelled** | write nothing, drop the stroke | write nothing, drop the stroke | every drag in this app |

Every gesture has one outcome, with no modes. The trigger-grid column is **full**,
which is why the ruler is separate. On the motion grid `wheel` and `right-click` are
deliberately free (its inventory is in [motion-sequencer](motion-sequencer.md)).

**Double-tap is hand-rolled** (`dblclick` is unreliable on touch) by five controls:
knob, EQ graph, scratch graph, resize handle and motion pad. Their windows live in
`ui/components/gesture-timing.ts`, and there are **two** (300 ms and 350 ms). That is
left as two on purpose: unifying them changes feel and wants someone at the controls.
Three of the five read wall time and two read `performance.now()`.

`Clear ▾` → bank is also how a bank becomes removable: the bank bar's `−` refuses while
the highest bank holds steps ([banks](banks.md) REQ-a-bank-is-removed-only-when-unused).
The two share one emptiness predicate.

### Contract / public interface

```yaml
attachGridGestures(opts): () => void        # src/ui/components/grid-gestures.ts
  cells: readonly (readonly HTMLElement[])[]  # [row][col]; single-row grids pass [cells]
  isOn(row, col): boolean                     # read the store, never cached DOM state
  onToggle(row, col, on): void                # tap + paint write through this
  onSelect(row, col): void                    # runs for every gesture, first
  holdMs?: number                             # default 350
  slopPx?: number                             # default 6
  # returns a disposer that removes every listener

createClearMenu(opts): HTMLElement           # src/ui/components/clear-menu.ts
  # opts: { lane: string, bankLabel(): string, onClearBank(): void,
  #         rows?: () => ClearMenuRow[] }
  #   bankLabel() and rows() are read at open time (the bank changes under us)
  # testids: clear-<lane>, clear-<lane>-bank, clear-<lane>-row-<i> (INDEXED, testids.md),
  #   clear-<lane>-shift-left / -right

ClearRow                                     # src/ui/panels/step-panel-scaffold.ts
  label:      string                         # what the item says it destroys
  hasContent: boolean                        # false ⇒ clearMenuFor drops the item. REQUIRED
  clear(): boolean                           # did anything actually go?
  undo?(): void                              # ONLY on a row that clears more than steps
  # rows() returns EVERY row; the filter is central; row testids stay contiguous
samplerSlotClearRow(engine, undo, slot): ClearRow   # sampler.md REQ-clear-ejects-the-slot

PatternStore:                                 # src/state/patterns.ts
  clearSeqBank(): boolean    / clearSeqTrack(track): boolean
  clearDrumBank(): boolean   / clearDrumTrack(track): boolean
  clearSamplerBank(): boolean / clearSamplerSlot(slot): boolean
  clearMotionBank(): boolean / clearMotionXy(): boolean / clearMotionTrack(t): boolean
  # each returns whether anything changed (no toast, no undo entry when nothing did)
  # each emits exactly ONE '<machine>-copy' mutation carrying the pre-clear bank
```

`isOn` reads the store, not the DOM, so a paint stroke survives a concurrent repaint
(a bank switch mid-drag). `onSelect` fires before `onToggle`, so the edit row already
points at the cell being written.

### Layer touchpoints & ordering

```yaml
step-panel-scaffold.ts:
  attachGridGestures  <- called by the trigger panels with their own cells/callbacks
  clearMenuFor(engine, lane, undo, rows?)  <- the header control per lane
seq/drum/sampler panels:
  the per-cell `click` listener is REPLACED by attachGridGestures (two paths writing
  `on` would double-toggle)
motion panel:
  keeps MotionStepPad's own pointer handling; takes only the Clear menu
pattern-row.ts:
  Delete/Backspace joins the tab-scoped Ctrl+Z wiring: one visibility rule
```

The controller is attached after the cells exist and before the first `paintAll`. It
never paints, only reports intent; the panels' `on*Change` subscriptions are the only
writers of cell visuals.

### Persistence

Nothing new. Not persisted: the selection cursor, the paint latch, the hold timer.

## Scenarios (BDD)

```gherkin
Scenario: A keyboard user programs a drum pattern (REQ-a-trigger-grid-is-reachable-by-keyboard)
  Given the drum grid, where only the selected cell is in the Tab order
  When the user tabs in and presses ArrowRight three times, then Enter
  Then step 4 of that row is selected, focused and switched on
  And ArrowDown moves to the next row, the same step
  And ArrowRight at the last played cell stays put
  And Space still toggles the transport, and Shift+ArrowRight still seeks
# pinned by: tests/ui/grid-keyboard.test.ts

Scenario: Shift rotates the played window and is one undo (REQ-shift-rotates-the-played-window)
  Given a drum bank whose kick has steps on cells 0 and 12, and a 16-cell window
  When Shift bank right is chosen
  Then the kick is on cells 1 and 13, every step's settings moved with it
  And one Undo restores cells 0 and 12
  Given a 12-cell window (3/4) with a step on cell 11
  When Shift bank right is chosen
  Then that step lands on cell 0, and cells 12..15 are untouched
  And an empty bank offers the shift but reports nothing
# pinned by: tests/state/patterns-rotate.test.ts, tests/ui/clear-menu.test.ts

Scenario: Editing a lit step no longer switches it off
  Given step 4 of the sequencer is on with note C4
  When the user presses and holds it for 400ms
  Then step 4 becomes the selected step and stays on
  And the edit row shows C4, ready to change
# pinned by: tests/ui/grid-gestures.test.ts, e2e/patterns.spec.ts

Scenario: A cancelled pointer does not toggle the step (regression)
  Given the user presses step 4, which is off
  When the OS cancels the pointer instead of releasing it
  Then step 4 is still off
  And the stroke's document listeners are gone
# pinned by: tests/ui/grid-gestures.test.ts

Scenario: A cancelled paint drag commits nothing further (regression)
  Given the user has pressed a lit step and painted across two more
  When the OS cancels the pointer
  Then no further cell changes, and the release path does not fire a tap
# pinned by: tests/ui/grid-gestures.test.ts

Scenario: Tap still toggles, and toggling off keeps the step's settings
  Given step 4 is on with note C4, velocity 0.6 and ratchet 3
  When the user taps it, then taps it again
  Then it ends up on with note C4, velocity 0.6 and ratchet 3 unchanged
# pinned by: tests/ui/grid-gestures.test.ts, tests/state/patterns.test.ts

Scenario: A lit beat-column step shows the selection ring (REQ-tap-toggles-a-step, regression)
  Given the Drum tab with step 5 — a red beat column — switched on
  When the user selects it
  Then it shows the same accent-secondary ring as a lit off-beat step
# pinned by: e2e/patterns.spec.ts

Scenario: One swipe erases a run of hits
  Given the closed-hat row has hits on steps 2, 4, 6 and 8
  When the user presses step 2 and drags across to step 8
  Then steps 2 through 8 are all off, in one gesture
# pinned by: tests/ui/grid-gestures.test.ts, e2e/patterns.spec.ts

Scenario: One swipe fills a run of hits (the paint latch)
  Given the closed-hat row is empty
  When the user presses step 0 and drags across to step 15
  Then every step the pointer entered is on
  And re-crossing a step already painted leaves it on (no flicker)
# pinned by: tests/ui/grid-gestures.test.ts

Scenario: A drag that starts on a lit cell erases even where it crosses dead cells
  Given steps 3 and 5 are on and step 4 is off
  When the user presses step 3 and drags through 4 to 5
  Then steps 3, 4 and 5 are all off (the latch is !first.on, not per-cell invert)
# pinned by: tests/ui/grid-gestures.test.ts

Scenario: Clearing a bank costs one undo press (REQ-one-bulk-action-one-undo-entry, regression)
  Given the drum bank has 40 active cells across several tracks
  When the user picks Clear ▾ → Clear bank
  Then every cell is off and a toast offers Undo
  When the user presses Undo once
  Then all 40 cells return
# pinned by: tests/state/patterns.test.ts, tests/state/pattern-undo.test.ts, e2e/patterns.spec.ts

Scenario: A row item destroys everything its label names (REQ-clear-menu-clears-in-bulk, regression)
  Given the Sampler tab's selected slot is named "kick.wav"
  When the user picks Clear ▾ → "Clear kick.wav"
  Then the filename is gone from the slot as well as its steps
  And the toast's Undo brings both back in one press
# pinned by: tests/ui/clear-menu-sampler.test.ts, e2e/sampler.spec.ts

Scenario: Delete clears the selected step only while the tab is visible (edge)
  Given the Sequencer tab is open with step 7 selected and on
  When the user presses Delete
  Then step 7 switches off
  When the user switches to the Sampler tab and presses Delete
  Then no sequencer step changes
# pinned by: e2e/patterns.spec.ts

Scenario: A long-press cancelled by movement paints instead of selecting (edge)
  Given the user presses a lit cell and immediately drags
  Then the hold never fires, the drag paints, and no stray toggle lands on release
# pinned by: tests/ui/grid-gestures.test.ts

Scenario: Right-click selects without toggling and shows no browser menu (edge)
  Given a lit step
  When the user right-clicks it
  Then it is selected, still on, and the context menu is suppressed
# pinned by: tests/ui/grid-gestures.test.ts

Scenario: A cursor machine offers no row item for an empty row (REQ-clear-menu-clears-in-bulk, regression)
  Given the Sequencer tab with the selected track empty
  When the Clear menu is opened
  Then it offers "Clear bank <x>" and nothing else — no dead "Clear track 2"
  When a step on that track is switched on and the menu reopened
  Then "Clear track 2" is back, because the menu is rebuilt on every open
# pinned by: tests/ui/clear-menu-rows.test.ts, e2e/patterns.spec.ts (seq + drum,
#            through the real panels)

Scenario: The sampler counts a loaded sample as content (REQ-clear-menu-clears-in-bulk, edge)
  Given a sampler slot that is named but has no steps in the edit bank
  When the Clear menu is opened
  Then its row item IS offered — the item removes the sample too (sampler.md
    REQ-clear-ejects-the-slot), so it is not a dead item
  And a slot with neither steps nor a sample offers nothing
# pinned by: tests/ui/clear-menu-rows.test.ts, tests/ui/clear-menu-sampler.test.ts

Scenario: Motion's Clear menu lists only the lanes that hold steps (REQ-clear-menu-clears-in-bulk)
  Given the Motion tab with anchors on the XY lane and on track B, and A empty
  When the Clear menu is opened
  Then it offers "Clear XY", "Clear B" and "Clear bank <x>" — but not "Clear A"
  When track B is then emptied and the menu reopened
  Then "Clear B" is gone, because the menu is rebuilt on every open
# pinned by: e2e/motion.spec.ts

Scenario: Clearing a motion bank clears every lane (REQ-clear-menu-clears-in-bulk, regression)
  Given the XY lane and the extra tracks hold anchors
  When Clear bank is picked
  Then every lane empties — "the bank" is every lane, as on the drum grid
  And one Undo press brings all of them back
# pinned by: tests/state/patterns.test.ts, tests/state/pattern-undo.test.ts

Scenario: Motion keeps drag-to-set and double-tap-to-clear (REQ-motion-keeps-its-own-gesture)
  Given the Motion tab is open
  When the user drags a mini pad
  Then it sets an anchor coordinate — it does not toggle or paint
  And Clear ▾ → Clear bank still clears all 16 anchors in one undo entry
# pinned by: tests/ui/motion-step-pad.test.ts, tests/state/patterns.test.ts, e2e/motion.spec.ts

Scenario: A hidden grid does no per-tick repainting (REQ-an-offscreen-grid-repaints-nothing, perf)
  Given the transport is playing and a machine panel's tab is not the visible one
  When steps elapse
  Then its playhead highlight and rest overlay are not touched at all
# pinned by: tests/ui/step-panel-scaffold.test.ts

Scenario: Revealing a tab shows the step playing NOW (REQ-an-offscreen-grid-repaints-nothing, the reveal contract)
  Given a hidden panel whose playhead was frozen several steps ago
  When its tab is revealed
  Then the highlight jumps to the current step, not the one it was left on
# pinned by: tests/ui/step-panel-scaffold.test.ts, e2e/patterns.spec.ts
```

## Tests & verification

- Unit: `tests/ui/grid-gestures.test.ts` (synthetic Pointer Events),
  `tests/ui/grid-keyboard.test.ts`, `tests/ui/step-panel-scaffold.test.ts`,
  `tests/ui/clear-menu.test.ts`, `tests/ui/clear-menu-rows.test.ts`,
  `tests/ui/clear-menu-sampler.test.ts`, `tests/state/patterns.test.ts`,
  `tests/state/patterns-rotate.test.ts`, `tests/state/pattern-undo.test.ts` —
  `npm test`. E2E: `e2e/patterns.spec.ts`, `e2e/motion.spec.ts`.

## Open questions / future

- **Multi-select / marquee** is out of scope: the store has one cursor, and `Clear ▾`
  plus paint-drag cover the cases. Revisit only if copy/paste of step ranges arrives.
- The 350 ms hold is one constant in `gesture-timing.ts`, if it proves long on touch.
