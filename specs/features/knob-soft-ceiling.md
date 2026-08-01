# Knob soft ceiling (the arc stops where the value stops mattering)

```yaml
id: knob-soft-ceiling
status: implemented
version: 2                      # v2: the dead region is marked, not left bare (REQ-5)
owner: core
related:
  - architecture
  - param-reset-baseline        # the gestures this must not disturb
  - runtime-performance         # REQ-7 repaint guards, preserved here
  - oscillators                 # the first (and currently only) consumer
  - lfo                         # REQ-8's taper is what forced v2
  - testids
source:
  - src/ui/components/knob.ts   # uiMax option + setUiMax + the render clamp
  - src/ui/styles/knob.module.css  # .dead — the marked region (v2)
  - src/ui/app.ts               # LFO panel: the lfo.rate ceiling on the PWM path
```

A per-instance **soft ceiling** on a `Knob`: above it the orange value arc stops
filling, while the value, the pointer line, the readout and every gesture carry on
unchanged. It is a disclosure device for the case where a param's registered range
is deliberately wider than the range the engine acts on.

## Background / Why

Some params are registered wider than the engine honours, on purpose. `lfo.rate`
is `0.05..20 Hz`, but on the PWM path the engine clamps it to `PWM_RATE_MAX = 10`
([oscillators](oscillators.md) REQ-9) — and narrowing the registered range is not
an option, because `preset-validate` would then reject every saved patch with a
faster LFO.

The knob did not say so. Its arc kept filling to 20 Hz as if something were still
happening, so the top half of the travel was dead but looked live. The only
disclosure was a sentence under the panel, and nothing drew the eye to it.

[ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1 ranks **self-evident
above explained above documented**. A ceiling on the arc moves this one rung up
that ladder: the bare grey track above the ceiling is the thing that makes a user
look down and read the sentence that was already there. The sentence stays — this
supplements prose, it does not replace it.

## Requirements

- **REQ-1** — A `Knob` accepts an optional **soft ceiling** expressed in *param
  units* (`10`, meaning 10 Hz — not a fraction, not a percent). Above it the value
  arc stops filling. Absent by default, so every existing knob renders exactly as
  before — [ADR-006](../decisions/adr-006-no-op-param-defaults.md)'s no-op-default
  discipline applied to a UI option.
- **REQ-2** — The ceiling is **paint only**. Drag, shift-fine-drag, double-tap
  reset ([param-reset-baseline](param-reset-baseline.md) REQ-6), the pointer
  line's rotation, the formatted readout and every `bus.set` are untouched. The
  user can still reach and store 20 Hz, and a preset that holds 20 Hz still loads,
  still sounds the same, and still round-trips. Nothing about the param registry
  changes.
- **REQ-3** — The ceiling is mapped to arc position through `toNorm`
  (`src/utils/taper.ts`), the same function the value itself goes through, so it
  lands correctly on `exp` / `power` / `discrete` knobs and not only on linear
  ones. A ceiling outside `[min, max]` is clamped to the ends; a ceiling at or
  above `max` is indistinguishable from having none.
- **REQ-4** — The ceiling is settable after construction (`setUiMax`), so a cap
  that only applies in *some* states can follow the bus. Passing `null` clears it
  and restores the full arc. Setting it repaints immediately at the current value
  rather than waiting for the next param change.
- **REQ-5** — (v2) The capped region is **marked**: a dim red arc (`--accent-bad`
  at reduced opacity) spanning ceiling→end of sweep, drawn beneath the value arc.
  - v1 left it as bare track, reasoning that absence reads as inertness. That
    held while the band was ~140° wide. `lfo.rate`'s exponential taper
    ([lfo](lfo.md) REQ-8) then moved the ceiling from ~50% to ~88% of the sweep
    and shrank the band to ~32°, at which size bare track is simply not noticed —
    the feature stopped doing the one job it exists for. **A positive mark is
    legible at a size absence is not.** This is the general lesson, not a fact
    about this knob: a cue built from *absence* degrades with the size of the gap.
  - Red rather than grey because the meaning is "blocked", not "empty", and the
    knob already has a dim-neutral element (`.track`) that means "not yet
    reached". Reduced opacity because it is a passive statement of range, not an
    error the user must act on.
  - The element is created **on demand**, so a knob without a ceiling has no
    extra node and no extra cost — the same lazy pattern as `StepButton`'s
    `.fill` layer.
- **REQ-6** — While a ceiling is active the knob root carries
  `data-uimax="<value>"`, removed when cleared. This is an assertable hook for
  e2e and self-documenting in devtools. Deliberately a data attribute and **not**
  a new testid — the [testids](testids.md) REQ-1 catalogue is unchanged, and the
  knob keeps its single `knob-<paramId>` identity.
- **REQ-7** — The ceiling is applied *before* the `lastDash` repaint guard
  ([runtime-performance](runtime-performance.md) REQ-7), so a value sweeping
  around above the ceiling collapses to **zero** DOM writes rather than one per
  frame. A capped knob is strictly cheaper to automate than an uncapped one, never
  more expensive.
- **REQ-8** — A soft ceiling is for a param whose *upper travel* is inert. Where
  the **whole** control is inert in some state, the existing full-knob
  `setDisabled` dimming is the right treatment instead (`filter.shape` on the
  ladder model, [filter-models](filter-models.md) REQ-7). The two are not
  interchangeable and a knob should not use both to say the same thing.

## Technical design

### Contract / public interface

```yaml
KnobOptions:                    # src/ui/components/knob.ts
  bus: ParamBus
  paramId: string
  label?: string
  size?: number
  uiMax?: number                # NEW — soft ceiling, in param units

Knob:
  setUiMax(max: number | null): void   # NEW — set/clear, repaints immediately
  setDisabled(on: boolean): void       # (existing) whole-control treatment, REQ-8
```

The ceiling is held internally as a **normalized** position (`uiMaxNorm`, default
`1`), converted once on set rather than on every frame. `render` then caps the arc
with a single `Math.min` against it:

```yaml
indicator rotation:  startDeg + norm * SWEEP_DEG              # true value
arc dash length:     dashOn * min(norm, uiMaxNorm)            # capped  <-- the change
value readout:       formatValue(value)                       # true value
```

The dial carries **three** concentric circles once a ceiling is set, painted in
this order so each later one covers the one before (v2):

```yaml
.track   full sweep, dim neutral      # travel not yet reached
.dead    ceiling -> end of sweep      # travel that does nothing   (v2, on demand)
.value   0 -> min(norm, uiMaxNorm)    # travel in effect
```

`.dead` is positioned with `stroke-dashoffset`, which `.track`/`.value` do not
use — they both start at the sweep origin, while `.dead` starts partway along it:

```yaml
length:  dashOn * (1 - uiMaxNorm)
offset:  -(dashOn * uiMaxNorm)        # negative delays the dash's start
```

It is repainted only when the **ceiling** moves, never per value change — it does
not depend on the value, so it stays out of `render` and off the automation path.

### Gesture inventory

Required by [`design-an-interaction`](../recipes/design-an-interaction.md) step 1.
This feature adds **no** gesture — the table exists to record that, and a `—` here
is a decision rather than an oversight.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| Drag (vertical) | Sets the value across the **full** registered range, ceiling or not | This knob, unchanged |
| Shift + drag | Same, fine (600 px full travel) | This knob, unchanged |
| Double-tap | Reset to baseline (`param-reset-baseline` REQ-6) | This knob, unchanged |
| Tap on the dead region | — no snap-to-ceiling, no toast, no resistance | Deliberate: see below |
| Hover / long-press | — | The panel hint already carries the explanation |

ADR-014 **law 2** ("one gesture, one outcome") is the reason this is safe: a
gesture's *outcome* never varies with whether a ceiling is present. Only the
painting differs. Had the ceiling instead clamped the drag, or snapped the value
back, the same drag would mean two different things depending on invisible state —
which is exactly the defect law 2 names.

Law 4 (precedent before inventing): LED-collar encoders on hardware controllers
light only the active portion of their ring and leave the rest dark, which is the
same "lit = live" convention this borrows. No hardware analogue exists for a
*partially* dead range, because hardware simply fits a pot with the right taper —
a luxury a param registry that must stay backwards-compatible does not have.

### Layer touchpoints

```yaml
ui: src/ui/components/knob.ts
      constructor(opts.uiMax) -> uiMaxNorm ; setUiMax(v|null) -> uiMaxNorm + data-uimax
      render() -> arc dash uses min(norm, uiMaxNorm)
ui: src/ui/app.ts -> pulseRateDisclosure(bus, rateKnob)
      ONE bus.subscribe('lfo.dest') drives BOTH cues:
        hint <p> visibility  AND  rateKnob.setUiMax(PWM_RATE_MAX | null)
audio: untouched. No engine, worklet or param-registry change.
```

The single subscription is load-bearing: the arc cap and the sentence explain each
other, so they must appear and disappear together. Two subscriptions could drift
and leave a capped arc with no explanation next to it.

### Persistence

None. A soft ceiling is a property of the *view*, not of the param — it is never
written to a preset, a song, or `localStorage`, and never read back from one. A
patch saved with `lfo.rate` at 20 Hz stores 20 and reloads at 20 whether or not a
ceiling was on screen when it was saved.

## Scenarios (BDD)

```gherkin
Scenario: The arc stops at the soft ceiling while the value keeps going
  Given a knob on lfo.rate with a soft ceiling of 10
  When the value is set to 20
  Then the value arc is filled only to the 10 Hz position
  And the pointer line and the "20.00Hz" readout still show the true value
# pinned by: tests/ui/knob.test.ts

Scenario: A knob with no ceiling is untouched (regression, REQ-1)
  Given a knob on lfo.rate constructed without a soft ceiling
  When the value is set to 20
  Then the value arc is filled to the full sweep
# pinned by: tests/ui/knob.test.ts

Scenario: The ceiling maps through the param's taper (REQ-3)
  Given a knob on a power-tapered param with a soft ceiling at its midpoint
  Then the arc caps at the tapered position, not at half the sweep
# pinned by: tests/ui/knob.test.ts

Scenario: Clearing the ceiling restores the full arc (REQ-4)
  Given a capped knob showing a value above its ceiling
  When setUiMax(null) is called
  Then the arc repaints to the true value without the param changing
  And the dead-region marker is removed from the DOM
# pinned by: tests/ui/knob.test.ts

Scenario: The dead region is marked, not merely absent (v2, REQ-5)
  Given a knob on lfo.rate with a soft ceiling of 10
  Then a .dead arc spans the ceiling to the end of the sweep
  And it is painted beneath the value arc, not over it
# pinned by: tests/ui/knob.test.ts

Scenario: A knob with no ceiling grows no extra element (v2, REQ-5)
  Given a knob constructed without a soft ceiling
  Then the dial holds only the track and value circles
# pinned by: tests/ui/knob.test.ts

Scenario: A capped knob costs nothing to automate (REQ-7, edge)
  Given a knob with a soft ceiling of 10
  When the value moves between two different values that are both above 10
  Then stroke-dasharray is written once, not twice
# pinned by: tests/ui/knob.test.ts

Scenario: Dragging past the ceiling still sets the real value (REQ-2)
  Given a capped knob on lfo.rate
  When the user drags to the top of the travel
  Then bus.get('lfo.rate') is 20, not the ceiling
# pinned by: tests/ui/knob.test.ts
```

## Tests & verification

- Unit: `tests/ui/knob.test.ts` — `npm test`. Assertions read `stroke-dasharray`
  off the `.value` circle and the `transform` off `.indicator`, so they pin the
  *paint*, which is the whole contract here.
- E2E: `e2e/controls.spec.ts` — `npm run e2e` (the `lfo.dest` wiring, via
  `data-uimax` on `knob-lfo.rate`).
- Typecheck: `npm run typecheck`.
- **By eye** — the point of the feature is perceptual, so a green suite does not
  settle it. LFO panel → DEST `pulse` → drag RATE up: the arc should freeze just
  short of halfway while the pointer and the Hz readout keep climbing. Switch DEST
  away and the arc must snap back to tracking the full range.
- **Not** an ADR-010 by-ear change: nothing under `src/audio/**` or
  `public/worklets/**` is touched, and the engine's behaviour at any rate is
  unchanged.

## Open questions / future

- The **XY pad** can be assigned `lfo.rate` too (`xy-pad.md`) and has no arc, so
  the same dead travel is undisclosed there. It needs a different visual answer —
  a tick on the axis, most likely — rather than a reuse of this one. Not built.
- ~~`lfo.rate` is **linear** over `0.05..20`, which spends half the travel between
  10 and 20 Hz while everything musically useful is crammed into the first ~5%.~~
  — done: `lfo.rate` is now `taper: 'exp'` ([lfo](lfo.md) REQ-8). The ceiling
  consequently sits at ~88% of the sweep rather than ~50%, so the dead region is
  a narrow band at the top of the dial instead of half of it. Note the taper
  change was *not* free the way a param-value change is: motion anchors are
  stored in taper space, see lfo REQ-8.
- No consumer yet needs a soft **floor**. If one appears, it is the same clamp on
  the other side plus a dash offset, but do not build it speculatively.
