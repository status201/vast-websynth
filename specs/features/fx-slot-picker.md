# FX slot picker (two effects share one panel, chosen from a title caret)

```yaml
id: fx-slot-picker
status: implemented
version: 2   # v2: the shown title opens the menu too (REQ-the-title-opens-the-menu) —
             #     only the small caret did, and the name beside it looked inert
owner: core
related:
  - chorus          # the first effect to share a slot (with the Phaser)
  - effects
  - fx-group        # the sampler's header group, which hosts a slot too
  - panel-tabs      # the precedent: two pages, one panel, session-only view state
  - onboarding      # REQ-a-container-must-tell-badges-when-it-hides
  - iconography
source:
  - src/ui/components/fx-slot-picker.ts
  - src/ui/components/menu-anchor.ts   # the shared anchor + dismiss (dropdown.md REQ-every-fixed-menu-shares-one-anchor-and-dismiss)
  - src/ui/styles/fx-slot-picker.module.css
  - src/ui/panels/fx-rack.ts         # synth: Phaser / Chorus panel
  - src/ui/panels/sampler-panel.ts   # sampler: PHASER / CHORUS group
  - src/ui/onboarding/info-badges.ts # the view shells join the reflow list
```

## Background / Why

The FX rack is six panels across a grid that is already full at desktop widths
(responsive-synth-panels), and the sampler's header FX cluster is just as
tight. A chorus is a seventh effect with no room of its own — so, like the two
LFOs ([lfo](lfo.md) REQ-the-two-lfos-share-one-panel), it **shares** a panel: the
Phaser's. The panel keeps its title exactly as it was and gains a small caret
beside it; the caret opens a menu naming the effects that live in the slot.
Choosing one swaps the panel's whole face — title, on/off switch, knobs — to that
effect. Both effects are independent: each keeps its own switch and knob values,
and both may run at once. The component is generic over any number of entries,
so a later flanger can join the same slot without new UI.

## Requirements

- **REQ-the-slot-shows-one-effect-at-a-time** — A slot holds two or more
  *views*, one per effect, each the effect's complete face (its own title, its
  own `Switch`, its own knobs). Exactly one view is visible; the others are
  `hidden`, but stay in the DOM with live subscriptions, so a hidden view is
  already correct when it is revealed (the [panel-tabs](panel-tabs.md) rule).
  The first entry is the **primary** — the view a slot shows by default.
- **REQ-the-title-is-unchanged-plus-a-caret** — Each view's title is built exactly
  as before (same element, class and text). The additions are the picker's
  caret, an icon-only button placed right after the title — inline SVG
  `caretDown` ([iconography](iconography.md)), never a typed `▾` — and, from v2,
  the picker's own `.title` hook on the title element (REQ-the-title-opens-the-menu).
  The picker moves with the view, so the caret always sits beside the title being
  shown.
- **REQ-the-title-opens-the-menu** (v2) — **Clicking the shown title does what
  clicking the caret does**: it opens the menu, or closes it if open. The caret
  is a 12px glyph, and the name beside it is the obvious place to aim. The title
  shows a pointer cursor, and hovering it lights the caret the way hovering the
  caret does, so the two read as one control. Each `FxSlotView` names its
  `titleEl`. The picker wires every view's title once, and since only the shown
  view is visible, only the shown title can be clicked. The title is **not** a
  focus stop: the caret is already a native button, and a second tab stop for the
  same action is noise. Keyboard users keep the caret.
- **REQ-the-menu-lists-every-effect-in-the-slot** — Clicking the caret opens a
  menu listing every entry by title. The shown view is marked `active`; an
  entry whose `<prefix>.on` is set carries a lit **lamp** (`lit`), so an effect
  running in a hidden view is never invisible state (ADR-014 law 5). Both marks
  are read **when the menu opens**. Choosing an entry shows its view and closes
  the menu. The menu is `position: fixed`, anchored to the caret and flipped up
  near the bottom edge, sized by its entries rather than the caret
  (`anchorMenu(…, 'content')`, [dropdown](dropdown.md)
  REQ-every-fixed-menu-shares-one-anchor-and-dismiss), and borrows
  `dropdown.module.css`'s look.
- **REQ-a-load-shows-the-running-effect** — `initialFxView(bus, entries)` picks
  the view: the **first non-primary entry that is on while the primary is off**,
  otherwise the primary. It runs when the slot is built — which covers a session
  restore, applied before the UI exists — and on `bus.onBulkApply` (a song, demo,
  preset, undo-stash apply or New) **only when the applied ids include one of the
  slot's `.on` ids**, so a synth preset load never moves the sampler's slot. An
  ordinary toggle — the user's switch, a motion lane, the XY pad — never moves the
  view: what the user is looking at is theirs.
- **REQ-the-view-is-session-only** — The shown view is view state, not sound: it
  is never a param, never saved and never persisted to storage
  ([panel-tabs](panel-tabs.md) REQ-selected-page-is-session-only).
- **REQ-the-picker-gesture-inventory** — (ADR-014) The complete set of gestures:

  | Gesture | Target | Result |
  | --- | --- | --- |
  | click / tap | caret | opens (or closes) the menu |
  | click / tap | the shown title (v2) | the same as the caret (REQ-the-title-opens-the-menu) |
  | Enter / Space | focused caret | the same — it is a native `<button>` |
  | click / tap | menu entry | shows that view, closes the menu |
  | click outside | anywhere | closes the menu, nothing changes |
  | Escape | while open | closes the menu, nothing changes; consumed, so it never reaches Panic |

  Hovering the title lights the caret. The title takes no keys and is not
  focusable. The menu consumes only the keys it handles
  ([input-control](input-control.md)).
- **REQ-a-slot-view-tells-badges-when-it-hides** — Each view is on the
  info-badge reflow list — in the synth rack its shell, `fxview-<prefix>`; in the
  sampler header the group root itself, `fxgroup-<prefix>`
  ([onboarding](onboarding.md) REQ-a-container-must-tell-badges-when-it-hides): a view
  swap changes no container's size, so without it the hidden title's badge
  would stay pinned and the shown one would not appear.
- **REQ-fx-slot-picker-testids** — The caret is `fxpick-<primary>`; each menu
  entry `fxpick-<primary>-<prefix>`; each synth-rack view shell
  `fxview-<prefix>` (a sampler view is its group, `fxgroup-<prefix>`). Every
  view's own controls keep the testids their factories mint
  (`switch-<prefix>.on`, `knob-<paramId>`, `fxgroup-<prefix>`).

## Technical design

### Contract / public interface

```yaml
FxSlotView:                      # src/ui/components/fx-slot-picker.ts
  prefix: string                 # the effect's param prefix, e.g. fx.chorus
  title: string                  # menu label
  el: HTMLElement                # the whole view; toggled hidden
  caretHost: HTMLElement         # the picker's caret is appended here when shown
  titleEl: HTMLElement           # v2: the view's title; a click on it toggles the menu
initialFxView(bus, views): string                    # REQ-a-load-shows-the-running-effect
createFxSlot(bus, views): { current: string; show(prefix): void }
```

### Layer touchpoints & ordering

- **Synth rack** (`fx-rack.ts`): the Phaser panel holds two views. Every rack
  panel's header is `[title row] [switch]`, the title row holding the title and,
  in a slot, the caret after it; `data-help` sits on the title row so the ⓘ
  badge lands after the caret, not on it. A single-effect panel's row holds
  only its title, which renders as it always did. The rack
  still has six panels, so its grid and `fxPatchDecoration` parity are untouched.
- **Sampler header** (`sampler-panel.ts`): two `fxGroup`s side by side in the
  FX cluster, each view being a group root; the caret goes in the group's
  `afterTitle` host (fx-group REQ-a-group-can-host-a-title-companion). Each group's `collapsed` behaviour is
  its own (fx-group REQ-bypassed-group-collapses-its-knobs), so a hidden-and-off
  group is collapsed too.
- **Dimmed knobs**: a chorus view dims the `CHORUS_MODE_OVERRIDES` knobs with
  `dimWhileModeSet` (`Knob.setDisabled` underneath) while `<prefix>.mode` is
  not FREE ([chorus](chorus.md)
  REQ-the-chorus-mode-overrides-rate-and-depth).

### Persistence

None — REQ-the-view-is-session-only.

## Scenarios (BDD)

```gherkin
Scenario: The Phaser is shown by default, its title intact
  Given a fresh session
  When the FX rack is built
  Then the slot shows the Phaser view, titled "Phaser" in the same element and class as before
   And a caret button sits right after the title
# pinned by: tests/ui/fx-slot-picker.test.ts

Scenario: The caret opens a menu that swaps the view
  Given the Phaser view is shown
  When the user clicks the caret and chooses "Chorus"
  Then the Chorus view is shown, the Phaser view is hidden, and the menu is closed
# pinned by: tests/ui/fx-slot-picker.test.ts, e2e/chorus.spec.ts

Scenario: The title opens the menu too (v2, REQ-the-title-opens-the-menu)
  Given the Phaser view is shown, in the synth rack or the sampler header
  When the user clicks the title "Phaser"
  Then the menu opens, and a second click on the title closes it
  And after choosing "Chorus", clicking the title "Chorus" opens it again
# pinned by: tests/ui/fx-slot-picker.test.ts

Scenario: The menu lamps a running effect (REQ-the-menu-lists-every-effect-in-the-slot)
  Given fx.chorus.on is 1 and the Phaser view is shown
  When the menu opens
  Then the Chorus entry is lit and the Phaser entry is marked active
# pinned by: tests/ui/fx-slot-picker.test.ts

Scenario Outline: A load shows the running effect (REQ-a-load-shows-the-running-effect)
  Given a song with fx.phaser.on <phaser> and fx.chorus.on <chorus>
  When it is applied
  Then the slot shows <view>
  Examples:
    | phaser | chorus | view   |
    | 0      | 0      | Phaser |
    | 1      | 0      | Phaser |
    | 1      | 1      | Phaser |
    | 0      | 1      | Chorus |
# pinned by: tests/ui/fx-slot-picker.test.ts, e2e/chorus.spec.ts

Scenario: A plain toggle never moves the view (edge)
  Given the Phaser view is shown and fx.chorus.on is 1
  When fx.phaser.on is switched off by a bus.set
  Then the Phaser view is still shown
# pinned by: tests/ui/fx-slot-picker.test.ts

Scenario: An unrelated bulk apply leaves the slot alone (edge)
  Given the sampler slot shows the Chorus view with both effects on
  When a synth preset is loaded
  Then the sampler slot still shows the Chorus view
# pinned by: tests/ui/fx-slot-picker.test.ts

Scenario: Escape and an outside click close without choosing (edge)
  Given the menu is open
  When the user presses Escape (or clicks elsewhere)
  Then the menu closes and the shown view is unchanged
# pinned by: tests/ui/fx-slot-picker.test.ts

Scenario: A preset mode dims RATE and DEPTH (chorus REQ-the-chorus-mode-overrides-rate-and-depth)
  Given the Chorus view is shown
  When fx.chorus.mode is set to I
  Then the RATE and DEPTH knobs are disabled, and enabled again at FREE
# pinned by: tests/ui/fx-slot-picker.test.ts
```

## Tests & verification

- `tests/ui/fx-slot-picker.test.ts` (jsdom) — structure, menu, load rule,
  toggles, dismissal, dimming.
- `e2e/chorus.spec.ts` — the synth and sampler slots in a real browser.
- `tests/ui/iconography.test.ts` stays green (the caret is SVG).
