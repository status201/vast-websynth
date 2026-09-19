# Lane fold — the chevron that is also a lane's label

```yaml
id: lane-fold
status: implemented
version: 1
owner: core
related:
  - architecture
  - sequencer                  # the first consumer — tracks 2-4
  - motion-sequencer           # the second — the single-param lanes
  - meter                      # why a fold must hide, never unbuild
  - iconography                # the caret is inline SVG, never a glyph
  - testids
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/ui/components/lane-fold.ts
  - src/ui/panels/seq-panel.ts
  - src/ui/panels/motion-panel.ts
```

A per-lane fold button for a step machine's **optional** lanes: a chevron that
doubles as the lane's label, folding that lane's grid to its header row. It owns
one behaviour the generic [`createCollapseToggle`](#not-createcollapsetoggle)
cannot express — *"start folded only while the lane is empty **and** the user has
never said otherwise"* — and the auto-reveal that keeps that promise across a
song load.

## Background / Why

A machine with optional lanes has a standing layout problem: the lanes that are
*usually* empty cost their full grid height on every session that does not use
them. The sequencer met it first at v3, when tracks 2–4 arrived
([sequencer](sequencer.md) REQ-tracks-two-to-four-collapse), and solved it inside
`seq-panel.ts` — a local `setFolded`, a local `localStorage` key and a local
auto-reveal list, about thirty lines.

The motion sequencer then hit the identical problem going from two single-param
lanes to four ([motion-sequencer](motion-sequencer.md)
REQ-an-empty-motion-lane-starts-folded). Copying thirty lines is how the two
would start disagreeing — on the storage key's shape, on whether clearing a lane
re-folds it, on which caret is drawn — so the behaviour is extracted here and
both panels call it. The contract below is exactly what the sequencer already
did; nothing about its behaviour changes.

### Not `createCollapseToggle`

`src/ui/components/collapse-toggle.ts` is the app's *section* fold (the FX
section, the About panels, the pattern row). It is deliberately not the base for
this one:

- It draws a **bare** caret and rotates it in CSS. A lane fold's caret sits
  beside the lane's letter and the two are one target, so the glyph is **swapped**
  (`caretRight` ↔ `caretDown`) rather than rotated — the button's content changes
  with the state, which a CSS rotation cannot do.
- Its `defaultCollapsed` is consulted **once**, at construction. A lane's default
  has to be re-derived on every song load, because the content it depends on
  arrives later. That is `reveal()`, and it has no equivalent there.
- It toggles the **global** `.collapsed` class. A lane lives inside a panel that
  may itself be inside a collapsed section, so a lane's folded state is a
  **module** class the caller names, never the global one.

Both survive; they answer different questions.

## Requirements

- **REQ-a-lane-fold-hides-the-body-not-the-header** — Folding sets the caller's
  `foldedClass` on the **row**, and the caller's own stylesheet is what hides
  that row's body beneath it (`.folded .trackBody { display: none }`). The
  component never touches the body element, so it needs no handle on one and
  cannot disagree with the panel about what "the body" is. The
  header row — the fold button itself and every control beside it — stays in the
  DOM and stays interactive. This is [ADR-014](../decisions/adr-014-dont-make-me-think.md)
  law 2 as a structural rule rather than a convention: a lane whose *assignment*
  control folded away with its body could never be assigned, so the fold would
  have a different outcome depending on invisible state.

  A consequence for the **caller**, and the one thing about this component that
  is easy to get wrong: a header that stays on screen must stay *live*. A panel
  that gates its repaint on `folded` has to gate the **body half only** — the
  controls in the header still have to track their store, or a folded lane ends
  up advertising state it no longer holds, which is a worse failure than hiding
  it would have been. The component cannot enforce this (it never touches either
  half), so it is written down here and both consumers are checked against it:
  the motion panel splits `paintHeader` from `paintBody`
  ([motion-sequencer](motion-sequencer.md) REQ-a-folded-motion-lane-does-no-repaint), and the
  sequencer's header carries only a mute Switch, which is bus-bound and repaints
  itself.

- **REQ-a-folded-lane-is-hidden-not-unbuilt** — A fold is `display: none` on the
  body, from the caller's own rule. Cells are **never** removed or skipped at build time. Both consumers hand
  their cells to `bindLaneGrid` and to `wirePlayhead`, which re-read them on
  every meter change and every tick ([meter](meter.md)
  REQ-cells-beyond-the-length-are-hidden owns the sibling rule for cells past the
  lane's length), and a testid that vanishes with a fold would make every E2E
  selector race the user's last click.

- **REQ-a-lane-folds-on-a-stored-preference-first** — The stored preference
  wins, always. `localStorage.getItem(storeKey)` returning `null` — "never
  toggled" — is what distinguishes a default from a choice, so the three states
  are `'1'` (the user folded it), `'0'` (the user opened it) and absent (derive
  it). Only a **click** writes; `setFolded(folded, persist = false)` and
  `reveal()` never do. A boolean field could not express this, which is why the
  raw `null` check is the contract and not an implementation detail.

- **REQ-an-untouched-lane-re-derives-its-default** — `reveal()` re-runs
  `defaultFolded()` **only** while nothing is stored, and only ever opens a lane
  — it never folds one. Panels call it when a bank or a song arrives, so a song
  that uses a lane never opens with that lane hidden. Deriving it at construction
  alone is not enough: the panel is built before any song is loaded.

- **REQ-a-locked-lane-draws-the-caret-disabled** — A lane the machine always
  shows (the sequencer's track 1) passes `locked: true`: the button is rendered,
  labelled and `disabled`, with a `title` saying why. It is drawn rather than
  omitted so the lanes' labels stay on one vertical line and the rows do not
  step sideways under each other.

- **REQ-the-fold-caret-is-an-icon-not-a-glyph** — The caret is
  `iconLabel('caretRight' | 'caretDown', label)` from
  `src/ui/components/ui-icons.ts` — inline SVG
  ([iconography](iconography.md) REQ-a-control-glyph-is-inline-svg). The app
  bundles no font, so a typed `▸` falls through to whatever symbol face the
  device picks. `tests/ui/iconography.test.ts` fails the suite on a new typed
  glyph.

- **REQ-a-lane-fold-mints-the-callers-testid** — The button's `data-testid` is
  passed in whole by the caller, not composed here
  ([testids](testids.md) REQ-non-param-buttons-take-an-explicit-testid). The two
  consumers' ids (`seq-track-fold-<t>`, `motion-trk-<t>-fold`) already differ in
  shape, and a factory that invented a third would orphan both.

## Technical design

### Contract / public interface

```yaml
LaneFoldOptions:
  label: string              # drawn beside the caret; the lane's letter or number
  storeKey: string           # websynth.ui.collapsed.<machine>track.<i>
  row: HTMLElement           # carries foldedClass; the caller's CSS hides its own body
  foldedClass: string        # the caller's CSS-Module class, never global .collapsed
  foldClass: string          # the button's own class, from the caller's module
  testId: string
  locked?: boolean           # renders the caret disabled (REQ-a-locked-lane-draws-the-caret-disabled)
  lockedTitle?: string       # why, e.g. 'Track 1 is always shown'
  title?: (folded) => string # defaults to Show/Hide this lane
  defaultFolded: () => boolean   # consulted only when nothing is stored
  onChange?: (folded) => void

LaneFold:
  el: HTMLButtonElement
  folded: boolean
  setFolded(folded, persist): void   # persist=false leaves storage untouched
  expand(): void                     # open it now, and remember that (persist=true)
  reveal(): void                     # REQ-an-untouched-lane-re-derives-its-default

createLaneFold(opts: LaneFoldOptions) -> LaneFold
```

`expand()` persists because it is only ever called from a user gesture that
implies the lane is wanted — picking a parameter for a motion lane. `reveal()`
does not, because a song load is not the user's statement about this lane.

### Layer touchpoints & ordering

```yaml
lane-fold.ts:   reads/writes localStorage[storeKey]; toggles opts.foldedClass on
                opts.row; swaps the button's iconLabel; no bus, no store, no
                knowledge of what a lane contains
seq-panel.ts:   one per track; locked on track 0; defaultFolded = !trackHasSteps(t);
                reveal() from onSeqBankChange
motion-panel.ts: one per single-param lane; never locked;
                defaultFolded = motionTrackIsEmpty (the store's own predicate,
                  so a lane folds on the same answer that serializes it);
                expand() from the param picker; reveal() from onMotionTrackChange
                  ONLY, per the lane that emission names — a bank switch and a
                  restore each emit it once per lane already
```

The component is constructed **after** its row and body exist and **before** the
panel's first repaint, so the initial fold state is applied to a built row.

### Persistence

`localStorage`, one key per lane, named by the caller:

```yaml
websynth.ui.collapsed.seqtrack.<0-3>       # sequencer (unchanged from v3)
websynth.ui.collapsed.motiontrack.<0-3>    # motion single-param lanes
```

Values are `'1'` / `'0'`; **absent means "never toggled"** and is load-bearing
(REQ-a-lane-folds-on-a-stored-preference-first). Deliberately not persisted: the
fold is view state and never reaches a preset, a song or a share link — the same
rule [panel-tabs](panel-tabs.md) REQ-selected-page-is-session-only states for a
tab, except that a fold *does* survive a reload, which is the one piece of view
state this app keeps.

## Scenarios (BDD)

```gherkin
Scenario: An empty lane starts folded and a filled one starts open
  Given no stored preference for either lane
  And lane C is empty while lane D holds steps
  When the panel is built
  Then lane C carries the folded class and lane D does not
# pinned by: tests/ui/lane-fold.test.ts

Scenario: A stored preference beats the default (REQ-a-lane-folds-on-a-stored-preference-first)
  Given the user has opened an empty lane, so '0' is stored
  When the panel is rebuilt
  Then the lane is open, although it is still empty
# pinned by: tests/ui/lane-fold.test.ts

Scenario: Only a click writes to storage (REQ-a-lane-folds-on-a-stored-preference-first)
  Given no stored preference
  When the panel is built and reveal() runs
  Then nothing is written, so the lane still re-derives next time
  When the user clicks the caret
  Then the new state is stored
# pinned by: tests/ui/lane-fold.test.ts

Scenario: A loaded song opens the lanes it uses (REQ-an-untouched-lane-re-derives-its-default)
  Given an untouched, folded, empty lane
  When a song arrives that fills it and reveal() runs
  Then the lane opens
  And a lane the user had folded deliberately stays folded
# pinned by: tests/ui/lane-fold.test.ts

Scenario: reveal() never folds (REQ-an-untouched-lane-re-derives-its-default)
  Given an untouched lane that is open, and content that then goes away
  When reveal() runs
  Then the lane stays open — the fold is a gesture, not a derived state
# pinned by: tests/ui/lane-fold.test.ts

Scenario: A locked lane renders a disabled caret (REQ-a-locked-lane-draws-the-caret-disabled)
  Given locked: true
  Then the button is present, labelled and disabled, and clicking it does nothing
# pinned by: tests/ui/lane-fold.test.ts

Scenario: The header survives the fold (REQ-a-lane-fold-hides-the-body-not-the-header)
  Given a folded lane
  Then its body carries the folded class's parent row, and every control in the
    header row is still in the DOM and still enabled
  And those controls still track the store — a caller's fold-gated repaint
    covers the body half only
# pinned by: tests/ui/lane-fold.test.ts, tests/ui/motion-panel.test.ts

Scenario: The caret is inline SVG (REQ-the-fold-caret-is-an-icon-not-a-glyph)
  Given a fold button in either state
  Then it contains an svg.ui-icon and no typed caret character
# pinned by: tests/ui/iconography.test.ts, tests/ui/lane-fold.test.ts
```

## Tests & verification

- Unit: `tests/ui/lane-fold.test.ts` — `npm test`
- Consumers: `tests/ui/motion-panel.test.ts`; the sequencer's own fold has no
  jsdom test and is pinned by `e2e/patterns.spec.ts` alone
- Drift pin: `tests/ui/iconography.test.ts` (REQ-the-fold-caret-is-an-icon-not-a-glyph)
- E2E: `e2e/motion.spec.ts`, `e2e/patterns.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- The drum and sampler tabs have eight lanes each and no fold at all. They are
  not *optional* lanes — every kit piece is always meaningful — so folding them
  would hide content rather than absence. If that changes, they are the third
  consumer and the contract already fits.
- `createCollapseToggle` and this component now both persist a fold under
  `websynth.ui.collapsed.*`. Merging them would mean one of the two callers
  giving up either the labelled caret or the global class; neither is worth it
  today, and the split is recorded above so the next reader does not re-litigate it.
