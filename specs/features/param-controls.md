# Param controls (bipolar knob · stepper · hold button)

```yaml
id: param-controls
status: implemented
version: 1
owner: ui
related:
  - zoetrope             # the feature that introduced all three
  - live-fx-window       # HoldButton absorbed its private momentary()
  - runtime-performance  # repaint guards
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/ui/components/knob.ts          # the bipolar render mode
  - src/ui/components/stepper.ts       # integer readout with magnet detents
  - src/ui/components/hold-button.ts   # latch-or-momentary button
  - src/ui/components/live-fx.ts       # consumer of HoldButton mode 'momentary'
  - src/ui/styles/stepper.module.css
  - src/ui/styles/hold-button.module.css
```

Three shared, param-bound control primitives added for
[zoetrope](zoetrope.md) and built to be reused. They are specified here rather
than inside that feature because a reusable facility should own its own
contract — a second consumer must not have to read an effect spec to learn how
the control behaves.

**Scope note.** This spec covers *only* these three additions. The
pre-existing param controls (`Knob`'s default unipolar behaviour, `Switch`,
`Segmented`, `Strip`, `ParamDropdown`) predate it and remain undocumented; the
gesture and lifecycle rules they all follow live in
[`../recipes/add-a-ui-component.md`](../recipes/add-a-ui-component.md).

## Background / Why

Zoetrope needs three gestures the rack did not have:

- **A knob that reads from the centre.** `sieve` is bipolar — counter-clockwise
  averages cycles toward the harmonic skeleton, clockwise subtracts that average
  and leaves the residue, centre is neutral. Drawn with the existing arc, which
  always fills from the −140° start, "neutral" looks like "half on". Three
  existing params are bipolar too (`fx.djfilter`, `filter.envAmount`,
  `master.pitchBend`), so this is a latent gap — but changing their appearance is
  not this change's business, hence **opt-in**.
- **A count, not a continuum.** `depth` is a number of cycles. 12 versus 13 is
  not a distinction anyone hears, and a knob invites the user to hunt for a
  value that does not exist. A boxed integer you drag through is honest about
  what the parameter is (ADR-014: make the control look like what it does).
- **A button you can play.** `freeze` is a performance control. Latching suits
  setting it; momentary suits playing it. Doing both from one button — latch on
  a click, momentary if held — is worth the small implementation cost, and the
  identical press-and-hold behaviour already existed as a private helper inside
  `live-fx.ts`, which now shares this one.

## Requirements

- **REQ-1** — `KnobOptions.bipolar?: boolean` (default false). When set, the
  value arc is drawn **from the centre of the sweep outward** — left of centre
  for values below the param's midpoint, right for above — instead of from the
  sweep start. The indicator angle, drag model, formatting, double-tap reset and
  the existing `lastDeg`/`lastDash`/`lastLabel` repaint guards are unchanged.
- **REQ-2** — A bipolar knob has a **centre detent**: while dragging, a
  normalized value within `DETENT` (0.02) of centre snaps to exactly the
  midpoint. Holding shift (already the fine-drag modifier) bypasses the detent,
  so a value just off centre is still reachable.
- **REQ-3** — Bipolar is **opt-in per call site**. No existing control changes
  appearance.
- **REQ-4** — `Stepper({ bus, paramId, label?, magnets? })` renders a boxed
  integer readout bound to a param. Vertical click-drag moves through values
  honouring `def.step` (default 1); the readout uses `def.format`/`def.labels`
  exactly as `Knob` does. Testid `stepper-<paramId>`.
- **REQ-5** — `magnets` is an ordered list of values that **snap** when the drag
  lands within one step of them (e.g. `[1,2,4,8,16,32,64]` for `depth`), so the
  musically meaningful counts are easy to hit and everything between them is
  still reachable. Shift bypasses the magnets as well as slowing the drag.
- **REQ-6** — `Stepper` double-tap (<300 ms) calls `bus.reset(paramId)` — the
  same gesture and baseline semantics as `Knob`
  ([param-reset-baseline](param-reset-baseline.md)).
- **REQ-7** — `createHoldButton({ mode, ... })` supports two modes.
  `'momentary'`: pointerdown → `onPress`, pointerup/leave/cancel → `onRelease`.
  `'latch'`: pointerdown → value 1; a pointerup **within** `HOLD_MS` (300)
  toggles the latch (0 if it was already 1 at pointerdown), a pointerup **after**
  `HOLD_MS` always returns to 0. So a click latches and a hold is momentary.
- **REQ-8** — `createHoldButton` in `'latch'` mode is param-bound: it writes the
  param and mirrors its value into the global `.on` class, so a preset load or
  motion automation lights the button without it being pressed.
- **REQ-9** — Every drag/hold listener is attached to `window` on
  **pointerdown** and removed on pointerup/cancel/`destroy()` — never from the
  constructor (`add-a-ui-component.md`). Listener counts must balance after
  `destroy()`.
- **REQ-10** — `live-fx.ts`'s private `momentary()` is **removed** in favour of
  `createHoldButton({ mode: 'momentary' })`. Its DJ-button styling stays at the
  call site via the `className` option — behaviour is unchanged.

## Technical design

### Contract / public interface

```yaml
KnobOptions:                       # src/ui/components/knob.ts (extended)
  bus / paramId / label? / size?   # unchanged
  bipolar?: boolean                # REQ-1..3

Stepper:                           # src/ui/components/stepper.ts (new)
  new Stepper({ bus, paramId, label?, magnets?: number[] })
  el: HTMLElement                  # testid stepper-<paramId>
  destroy(): void

createHoldButton(opts): HTMLButtonElement   # src/ui/components/hold-button.ts (new)
  opts:
    mode: 'latch' | 'momentary'
    label: string
    testId: string
    className?: string             # defaults to the shared switch base
    bus?, paramId?                 # required for mode 'latch'
    onPress?, onRelease?           # required for mode 'momentary'
  constants: HOLD_MS = 300
```

### Layer touchpoints & ordering

Pure UI. No audio, no `ParamBus` registry changes — these controls bind to
params the same way `Knob`/`Switch` already do, so a param needs no special
declaration to be driven by one. `Stepper` reads `def.step` and `def.min/max`
from the registry; `magnets` is a call-site concern, not a param property,
because the same param could be meaningful with different magnets elsewhere.

## Scenarios (BDD)

```gherkin
Scenario: A bipolar knob draws its arc from the centre
  Given a knob on a param with min -1, max 1 and bipolar: true
  When the value is 0
  Then the arc has zero length and the indicator points straight up
  When the value is -0.5
  Then the arc spans from the centre leftward
# pinned by: tests/ui/knob.test.ts

Scenario: The centre detent snaps, shift defeats it
  Given a bipolar knob being dragged
  When the drag lands within the detent of centre
  Then the param is set to exactly the midpoint
  When the same drag is made with shift held
  Then the param keeps its off-centre value
# pinned by: tests/ui/knob.test.ts

Scenario: A unipolar knob is unaffected (REQ-3, regression)
  Given a knob built without the bipolar option
  Then its arc still fills from the sweep start
# pinned by: tests/ui/knob.test.ts

Scenario: A stepper drags through integers and snaps to magnets
  Given a stepper on fx.zoetrope.depth with magnets [1,2,4,8,16,32,64]
  When the user drags upward
  Then the value moves through whole numbers
  And a drag landing one step from 32 sets exactly 32
# pinned by: tests/ui/stepper.test.ts

Scenario: A stepper resets on double-tap
  When the user double-taps the readout
  Then bus.reset is called for its param
# pinned by: tests/ui/stepper.test.ts

Scenario: A latch button latches on a click
  When the user presses and releases within 300 ms
  Then the param is 1 and stays 1
  When the user clicks it again
  Then the param returns to 0
# pinned by: tests/ui/hold-button.test.ts

Scenario: A latch button is momentary when held
  When the user presses, waits past 300 ms, then releases
  Then the param was 1 while held and is 0 after release
# pinned by: tests/ui/hold-button.test.ts

Scenario: A held button releases if the pointer is cancelled (edge)
  When the pointer is cancelled or leaves while held
  Then the button releases exactly as on pointerup
# pinned by: tests/ui/hold-button.test.ts

Scenario: Controls leak no listeners
  When a Stepper or hold button is dragged and then destroyed
  Then every window listener it added has been removed
# pinned by: tests/ui/stepper.test.ts, tests/ui/hold-button.test.ts
```

## Tests & verification

- `tests/ui/knob.test.ts` — bipolar arc, detent, shift bypass, unipolar
  regression, repaint guards.
- `tests/ui/stepper.test.ts` — integer drag, magnets, reset, listener balance.
- `tests/ui/hold-button.test.ts` — latch vs momentary, cancel/leave, both modes.
- `npm test` / `npm run typecheck`.

## Open questions / future

- `fx.djfilter`, `filter.envAmount` and `master.pitchBend` are bipolar params
  still drawn unipolar. Adopting `bipolar: true` for them is a one-word change
  per call site, deliberately deferred so this change carries no unrelated
  visual churn.
- Deriving `bipolar` automatically from `def.min < 0 && def.max === -def.min`
  was rejected for the same reason — it would silently restyle those three.
