# Step-grid editing (the shared gesture model)

```yaml
id: step-grid-editing
status: implemented
version: 1
owner: core
related:
  - architecture
  - ../decisions/adr-014-dont-make-me-think
  - ../recipes/design-an-interaction
  - sequencer
  - drum-machine
  - sampler
  - motion-sequencer
  - step-settings
  - pattern-undo
  - banks
  - toast
source:
  - src/ui/components/grid-gestures.ts    # the one gesture controller
  - src/ui/components/clear-menu.ts       # the Clear ▾ header control
  - src/ui/panels/step-panel-scaffold.ts  # wires both into every machine tab
  - src/ui/panels/seq-panel.ts
  - src/ui/panels/drum-panel.ts
  - src/ui/panels/sampler-panel.ts
  - src/ui/panels/motion-panel.ts
  - src/state/patterns.ts                 # bulk clear entry points
```

The interaction contract every 16-step grid obeys — how a step is created,
selected, edited and deleted. A **cross-cutting facility**: the four machine
specs describe *what their steps mean*, this one describes *how the user touches
them*, and they reference it rather than restating it.

## Background / Why

Each panel wired its own click handler, and all of them gave that one click
**two jobs**: move the selection cursor *and* toggle `on`. The consequence is
the reason this spec exists — selecting a lit step in order to edit its note or
velocity switched the step off, so the note vanished under the pointer and the
user had to click again to restore it before editing. Two clicks and a visible
"did I just break it?" moment for what should be a single, obvious act. That is
[ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 (one gesture, one
outcome) violated identically in four places.

Deleting was the mirror-image problem: the only way to clear anything was one
click per cell, so wiping a hat line meant sixteen precise clicks and clearing a
bank meant a hundred and twenty-eight.

The fix keeps **tap = toggle** — that is 40 years of drum-machine muscle memory
and the one gesture nobody should have to learn ([ADR-014](../decisions/adr-014-dont-make-me-think.md)
law 4) — and gives the second job its own gesture. Two more gestures come along
because they are already learned elsewhere: **paint-drag** (FL Studio, Ableton,
Logic) turns "wipe a run of steps" into one swipe, and **hold-to-edit**
(Elektron parameter locks, Ableton Push step detail) is the established hardware
answer to "inspect this step without disturbing it".

## Requirements

- **REQ-1** — **Tap toggles.** A tap/click on a step inverts its `on` flag and
  moves the selection cursor to it. This is unchanged behaviour and stays the
  primary gesture on all four machines. The cursor must be **visible on every
  cell** regardless of its accent colour or lit state — the drum/sampler grids
  colour their beat columns (steps 1/5/9/13) red, and a lit red cell shows the
  same accent-secondary ring as any other. An invisible cursor is a functional
  defect, not a cosmetic one: selection is what the per-step edit row and
  `Delete` (REQ-5) act on.
- **REQ-2** — **Toggling off is non-destructive.** Switching a step off clears
  only `on`; `note` / `velocity` / `gate` / `prob` / `ratchet` / `tie` (and
  motion's `x`/`y`) are preserved, so toggling back on restores the step exactly.
  The cell keeps its label and stays selected. (Already true of the store — this
  requirement pins it, because it is what makes REQ-1 safe.)
- **REQ-3** — **Hold-to-edit selects without toggling.** A press held ≥ 350 ms
  without leaving the cell moves the selection cursor and does **not** toggle.
  The gesture is cancelled by pointer travel beyond 6 px (so it never fires
  mid-drag) and suppresses the tap that would otherwise follow on release.
  **Right-click** (`contextmenu`, default prevented) is the desktop alias for
  the same outcome — never the only route, since phones have no right-click.
- **REQ-4** — **Drag paints.** A pointer that presses a cell and travels to
  others applies one **paint value**, latched at press time as `!first.on`, to
  every cell it enters. Pressing a lit cell therefore erases the run; pressing a
  dead cell fills it. Painting never alters a cell already at the paint value,
  so re-crossing a cell cannot flicker it. Painting is confined to the grid the
  gesture started in (a drag cannot leak from the drum grid into the sampler's)
  and, on the drum/sampler grids, is **not** confined to one row — a diagonal
  swipe paints what it touches, matching DAW grid behaviour.
- **REQ-5** — **Delete clears the selected step.** `Delete` or `Backspace`,
  while the machine's tab is the visible one, switches the selected step off
  (same non-destructive rule as REQ-2). It is scoped exactly like the existing
  tab-scoped `Ctrl+Z` ([pattern-undo](pattern-undo.md)), so it can never reach a
  grid that is off screen, and it is ignored while focus is in a text input.
- **REQ-6** — **`Clear ▾` clears in bulk.** Every machine header carries a Clear
  control offering **Clear bank** (every step of the edit bank, *all* of its rows)
  plus **row-scoped** items. The menu is rebuilt **on every open**, because what
  it can offer moves under it — the edit bank, the selected row, and which rows
  even hold steps:
    - machines with a selection cursor (seq / drum / sampler) offer the **one
      selected row** — `Clear <track|slot|track n>`;
    - **Motion has no selection cursor**, so it instead lists **every lane that
      currently holds steps** (`XY`, `A`, `B`). An empty lane is not offered:
      a menu item that would do nothing is a dead item
      ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1).
  Each item is a single `PatternStore` call that emits **one** bulk mutation, so
  one `Undo` press restores everything (REQ-7). No confirmation dialog — the
  action is labelled and instantly reversible, which
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 3 prefers over
  interrupting every correct use.
- **REQ-7** — **One bulk action = one undo entry.** Bulk clears reuse the
  existing whole-bank mutation kinds (`seq-copy` / `drum-copy` / `sampler-copy` /
  `motion-copy`), whose `before` already carries a full clone of the bank. A
  clear must never emit N per-cell mutations — 128 undo presses to reverse one
  click is the failure this pins.
- **REQ-8** — **A bulk clear reports itself.** Clearing shows a
  [toast](toast.md) naming what was cleared with an **Undo** action wired to the
  machine's `PatternUndo` stack, so the escape hatch is on screen rather than
  remembered.
- **REQ-9** — **Motion keeps its own primary gesture.** The motion grid's cells
  are mini XY pads where a press *is* a coordinate set, so REQ-1/REQ-3/REQ-4 do
  not apply to it: drag-to-set and double-tap-to-clear stay as specified in
  [motion-sequencer](motion-sequencer.md) REQ-8. Motion takes **REQ-6/7/8 only**
  (Clear bank, single-entry undo, the toast). REQ-5's `Delete` deliberately does
  **not** reach it: motion has no selection cursor, so the key would have to act
  on an invisible "last touched" pad — inventing hidden state to delete from is
  precisely what [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 5
  forbids, and per-pad double-tap already clears one anchor directly.
  Clearing a motion bank keeps the bank's **axis override** (configuration, not
  step data), and undo restores it unchanged.
- **REQ-10** — **One implementation.** The gesture layer is a single controller
  (`attachGridGestures`) wired from `step-panel-scaffold.ts`, not re-implemented
  per panel. Adding a fifth machine, or a track to an existing one, inherits the
  full gesture set with no new listener code.
- **REQ-11** — **Touch parity.** All of the above run on Pointer Events, so a
  finger and a mouse take the same code path. No gesture is hover-only, and the
  long-press window and travel slop are tuned so a scroll gesture that starts on
  a cell scrolls rather than paints.

## Technical design

### Gesture inventory

The contract in one table (the [recipe](../recipes/design-an-interaction.md)
step-1 artefact). "Trigger grids" = seq / drum / sampler.

| Gesture | Trigger grids | Motion grid | Precedent |
| --- | --- | --- | --- |
| tap / click | toggle `on` + select | set `(x,y)` anchor | TR-808; Electribe |
| drag | paint `!first.on` | set `(x,y)` continuously | FL Studio, Ableton |
| long-press ≥ 350 ms | **select only** | — (press sets a value) | Elektron, Push |
| right-click | select only | — | — |
| double-tap | — (tap already toggles) | clear the anchor | Electribe |
| wheel | ±1 semitone (seq only) | — | — |
| `Delete` / `Backspace` | clear selected step | clear selected step | DAW piano roll |
| `Clear ▾` → bank | clear the edit bank | clear the edit bank | — |
| `Clear ▾` → row | clear the selected row | clear a named lane (XY/A/B) | — |

Every gesture has exactly one outcome, independent of hidden state — there is no
mode anywhere in this table.

### Contract / public interface

```yaml
attachGridGestures(opts): () => void        # src/ui/components/grid-gestures.ts
  # opts:
  cells: readonly (readonly HTMLElement[])[]  # [row][col]; single-row grids pass [cells]
  isOn(row, col): boolean                     # read the store, never cached DOM state
  onToggle(row, col, on): void                # tap + paint write through this
  onSelect(row, col): void                    # runs for every gesture, first
  holdMs?: number                             # default 350
  slopPx?: number                             # default 6
  # returns a disposer that removes every listener

createClearMenu(opts): HTMLElement           # src/ui/components/clear-menu.ts
  # opts: { lane, rowLabel?(): string, onClearRow?(): void, onClearBank(): void }
  # testids: clear-<lane>, clear-<lane>-row, clear-<lane>-bank

PatternStore:                                 # src/state/patterns.ts — REQ-6/REQ-7
  clearSeqBank(): boolean    / clearSeqTrack(track): boolean
  clearDrumBank(): boolean   / clearDrumTrack(track): boolean
  clearSamplerBank(): boolean / clearSamplerSlot(slot): boolean
  clearMotionBank(): boolean / clearMotionXy(): boolean / clearMotionTrack(t): boolean
  # each returns whether anything changed, so an already-empty target shows no
  # toast and pushes no undo entry
  # each emits exactly ONE '<machine>-copy' mutation carrying the pre-clear bank
```

`isOn` reads the store rather than the DOM so a paint stroke cannot desynchronise
from a concurrent repaint (a bank switch mid-drag), and `onSelect` fires before
`onToggle` so the per-step editor is already pointing at the cell being written.

### Layer touchpoints & ordering

```yaml
step-panel-scaffold.ts:
  attachGridGestures  <- called by all four panels with their own cells/callbacks
  clearMenuFor(engine, lane, cursor?)  <- builds the header control per lane,
                                          reusing laneHooks for the bank label
seq/drum/sampler panels:
  the per-cell `click` listener is REPLACED by attachGridGestures (not layered:
  two paths writing `on` would double-toggle)
motion panel:
  keeps MotionStepPad's own pointer handling (REQ-9); takes only the Clear menu
app.ts:
  the Delete/Backspace handler joins the existing tab-scoped Ctrl+Z wiring, so
  both share one visibility rule
```

Ordering that matters: the gesture controller must be attached **after** the
cells exist but **before** the first `paintAll`, and the panels' existing
`onSeqChange` / `onDrumChange` / … repaint subscriptions stay the only thing that
writes cell visuals — the controller never paints, it only reports intent. That
keeps the store the single source of truth during a paint stroke.

### Persistence

Nothing new is persisted. Gestures are transient; the cleared banks persist
through the existing song/session paths. Deliberately **not** persisted: the
selection cursor, the paint latch, the long-press timer.

## Scenarios (BDD)

```gherkin
Scenario: Editing a lit step no longer switches it off
  Given step 4 of the sequencer is on with note C4
  When the user presses and holds it for 400ms
  Then step 4 becomes the selected step and stays on
  And the edit row shows C4, ready to change
# pinned by: tests/ui/grid-gestures.test.ts, e2e/patterns.spec.ts

Scenario: Tap still toggles, and toggling off keeps the step's settings
  Given step 4 is on with note C4, velocity 0.6 and ratchet 3
  When the user taps it, then taps it again
  Then it ends up on with note C4, velocity 0.6 and ratchet 3 unchanged
# pinned by: tests/ui/grid-gestures.test.ts, tests/state/patterns.test.ts

Scenario: A lit beat-column step shows the selection ring (REQ-1, regression)
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

Scenario: Clearing a bank costs one undo press (REQ-7, regression)
  Given the drum bank has 40 active cells across several tracks
  When the user picks Clear ▾ → Clear bank
  Then every cell is off and a toast offers Undo
  When the user presses Undo once
  Then all 40 cells return
# pinned by: tests/state/patterns.test.ts, tests/state/pattern-undo.test.ts, e2e/patterns.spec.ts

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

Scenario: Motion's Clear menu lists only the lanes that hold steps (REQ-6)
  Given the Motion tab with anchors on the XY lane and on track B, and A empty
  When the Clear menu is opened
  Then it offers "Clear XY", "Clear B" and "Clear bank <x>" — but not "Clear A"
  When track B is then emptied and the menu reopened
  Then "Clear B" is gone, because the menu is rebuilt on every open
# pinned by: e2e/motion.spec.ts

Scenario: Clearing a motion bank clears every lane (REQ-6, regression)
  Given the XY lane and both extra tracks hold anchors
  When Clear bank is picked
  Then all three lanes empty — "the bank" is every lane, as on the drum grid
  And one Undo press brings all of them back
# pinned by: tests/state/patterns.test.ts, tests/state/pattern-undo.test.ts

Scenario: Motion keeps drag-to-set and double-tap-to-clear (REQ-9)
  Given the Motion tab is open
  When the user drags a mini pad
  Then it sets an anchor coordinate — it does not toggle or paint
  And Clear ▾ → Clear bank still clears all 16 anchors in one undo entry
# pinned by: tests/ui/motion-step-pad.test.ts, tests/state/patterns.test.ts, e2e/motion.spec.ts
```

## Tests & verification

- Unit: `tests/ui/grid-gestures.test.ts` (the inventory, in jsdom with synthetic
  Pointer Events), `tests/state/patterns.test.ts` (bulk clears + one-mutation
  emission), `tests/state/pattern-undo.test.ts` (single-entry reversal) —
  `npm test`
- E2E: `e2e/patterns.spec.ts` (hold-to-edit, paint-drag, Clear + toast Undo,
  tab-scoped Delete), `e2e/motion.spec.ts` (REQ-9) — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.patterns.seq[4].on` etc. (DEV only)

## Open questions / future

- **Multi-select / marquee** is deliberately out of scope: the store has no
  selection model beyond a single cursor, and `Clear ▾` plus paint-drag covers
  the cases it would serve. Revisit only if copy/paste of step *ranges* is added.
- **Nudge / rotate a pattern** (shift all steps left/right) is a natural
  neighbour of `Clear ▾` and would reuse the same one-bulk-mutation rule.
- The 350 ms hold window is a first guess from the `MotionStepPad` double-tap
  window; if it proves long on touch it is one constant in `grid-gestures.ts`.
