# Knob keyboard access (every knob is a slider you can reach and turn)

```yaml
id: knob-keyboard-access
status: implemented
version: 1
owner: core
related:
  - architecture
  - input-control               # REQ-octave-shift-is-minus-and-equal — why the bare arrows are free
  - param-reset-baseline        # REQ-double-tap-and-reset-share-one-path — the reset the Delete key reuses
  - knob-soft-ceiling           # the other per-knob option; paint only, untouched here
  - tempo-lock                  # a locked knob hides its dial, and with it the focus target
  - runtime-performance         # REQ-dom-writes-are-guarded-on-what-is-rendered — the ARIA writes follow it
  - dropdown                    # REQ-arrow-keys-move-the-selection — the same "a focused control owns its keys" rule
source:
  - src/ui/components/knob.ts
  - src/ui/styles/knob.module.css   # the focus ring
```

Every `Knob` is a keyboard-operable, screen-reader-legible **slider**. Before this
there was no way to reach one without a pointer: about a hundred controls on the
faceplate had no `tabindex`, no role, no value a screen reader could announce, and
no key that moved them.

## Background / Why

The knob was built pointer-first — drag, Shift-drag, double-tap — and nothing
else. [ADR-014](../decisions/adr-014-dont-make-me-think.md) asks for every
interactive control to be reachable, and the dropdown and the step-settings
sliders already are ([dropdown](dropdown.md) REQ-arrow-keys-move-the-selection,
[step-settings](step-settings.md)). The knob could not follow them because the
bare arrow keys shifted the keyboard octave app-wide; that moved to `-` / `=`
([input-control](input-control.md) REQ-octave-shift-is-minus-and-equal), which is
what makes this possible without a tug-of-war.

## Requirements

- **REQ-a-knob-is-a-focusable-slider** — **The dial is a focusable `slider`.**
  It carries `role="slider"`, `tabindex="0"`, `aria-label` (the knob's label),
  `aria-valuemin` / `aria-valuemax` (the param's registered range),
  `aria-valuenow` (the value) and `aria-valuetext` (the formatted readout, so a
  screen reader says `2.67Hz`, not `2.6666`). It shows a visible focus ring on
  `:focus-visible` only, so a pointer drag never leaves one behind. A
  tempo-locked knob hides its dial (tempo-lock.md
  REQ-locked-the-division-replaces-the-dial), and a hidden element is not
  focusable, so the lock chip is what a keyboard reaches there — nothing extra is
  needed.
- **REQ-the-keys-a-focused-knob-owns** — **A focused knob owns the keys that move
  it, and only those.** They go through `bus.set`, exactly as a drag does:
  - `ArrowUp` / `ArrowRight` raise and `ArrowDown` / `ArrowLeft` lower it by
    **1 %** of its travel (in the knob's own taper, like a drag), or by **one
    step** for a discrete param.
  - With **Shift** held the step is **a quarter** of that — the drag's fine
    ratio, 200 : 600, rounded to a keyboard-sized notch. A discrete param still
    moves one step.
  - `PageUp` / `PageDown` move **10 %** (a discrete param: one step).
  - `Home` / `End` go to the minimum / maximum.
  - `Delete` / `Backspace` reset it — the same `bus.reset` a double-tap performs
    ([param-reset-baseline](param-reset-baseline.md)
    REQ-double-tap-and-reset-share-one-path), so the keyboard reaches the value a
    preset or song set, not a hard default.
  Each of these is `preventDefault` + `stopPropagation`, so the page does not
  scroll and the global shortcuts never see it: `Home` would seek the transport,
  Shift+arrows move a bar, `Delete` clear a step. **Every other key passes
  through untouched** — a focused knob still lets the letter keys play notes and
  Space toggle the transport.
- **REQ-a-disabled-knob-ignores-keys** — A disabled knob (`setDisabled`, e.g. the
  BPM knob while slaved — midi-clock-sync REQ-the-bpm-knob-shows-slaved) stays
  focusable, so it can still be read, and carries `aria-disabled="true"`, but
  moves on no key — the same rule its pointer handler already follows. Its keys
  pass through.
- **REQ-the-aria-value-is-written-like-the-dial** — `aria-valuenow` and
  `aria-valuetext` are written in `render` behind the same guard as the readout
  (runtime-performance.md REQ-dom-writes-are-guarded-on-what-is-rendered): only
  when the formatted readout changes. A knob the motion sequencer sweeps at 60 fps
  therefore writes the attributes no more often than it already rewrites its
  label.

## Technical design

### Contract / public interface

```ts
// src/ui/components/knob.ts — no new options; every knob gets it.
// The dial element (`.knob-dial`) is the slider:
//   role="slider" tabindex="0" aria-label aria-valuemin/max/now/valuetext
// keydown on the dial → nudge(±fraction | ±step) / min / max / bus.reset
```

### Gesture inventory — a focused knob (ADR-014)

| Gesture | Knob | Precedent |
| --- | --- | --- |
| Tab / Shift+Tab | focus / leave the dial | every native control |
| ArrowUp / ArrowRight | +1 % (discrete: +1 step) | WAI-ARIA slider |
| ArrowDown / ArrowLeft | −1 % (discrete: −1 step) | WAI-ARIA slider |
| Shift + arrow | ±0.25 % (discrete: ±1 step) | the knob's own Shift-drag |
| PageUp / PageDown | ±10 % (discrete: ±1 step) | WAI-ARIA slider |
| Home / End | minimum / maximum | WAI-ARIA slider |
| Delete / Backspace | reset to the preset/song value | the knob's double-tap |
| Any other key | passes through to the global shortcuts | — |
| Pointer drag / double-tap | unchanged | knob-soft-ceiling REQ-soft-ceiling-is-paint-only |

### Layer touchpoints & ordering

```yaml
keydown (dial) -> handled key? -> preventDefault + stopPropagation -> bus.set / bus.reset
               -> otherwise    -> bubbles to window -> installShortcuts
render(value)  -> label changed? -> textContent + aria-valuenow + aria-valuetext
```

## Scenarios (BDD)

```gherkin
Scenario: A knob is a slider a screen reader can read (REQ-a-knob-is-a-focusable-slider)
  Given any knob
  Then its dial has role slider, tabindex 0, an aria-label and the param's range
   And aria-valuetext is the same string as the visible readout
# pinned by: tests/ui/knob.test.ts

Scenario: The arrow keys turn a focused knob (REQ-the-keys-a-focused-knob-owns)
  Given a focused knob on a continuous param
  When the user presses ArrowUp, then Shift+ArrowUp, then PageDown
  Then the value moves 1 %, 0.25 % and then -10 % of its travel, through bus.set
   And a discrete param moves exactly one step per key
# pinned by: tests/ui/knob.test.ts

Scenario: Home, End and Delete belong to the knob, not the transport (REQ-the-keys-a-focused-knob-owns, edge)
  Given a focused knob and a playing transport
  When the user presses Home, End or Delete
  Then the knob goes to its minimum, its maximum, or its reset value
   And the keydown never reaches the window, so nothing seeks and no step is cleared
   And a letter key or Space on a focused knob still reaches the window
# pinned by: tests/ui/knob.test.ts

Scenario: A disabled knob can be read but not turned (REQ-a-disabled-knob-ignores-keys)
  Given the BPM knob disabled while slaved
  When it is focused and ArrowUp is pressed
  Then the value does not change and the key passes through
# pinned by: tests/ui/knob.test.ts

Scenario: An automated knob writes its ARIA value only when its readout changes (REQ-the-aria-value-is-written-like-the-dial)
  Given a knob swept by automation through values that format identically
  Then aria-valuetext is written no more often than the readout
# pinned by: tests/ui/knob.test.ts
```

## Tests & verification

- `tests/ui/knob.test.ts` — roles, keys, pass-through, disabled, the write guard.
- `npm run typecheck && npm test`.
- By hand: Tab onto a knob, turn it with the arrows and hear it; confirm the
  focus ring appears on Tab but not after a mouse drag.

## Open questions / future

- The drum and sampler step grids and the XY pad are still pointer-only. The XY
  pad is two-dimensional and wants its own gesture design (arrows for one axis,
  Shift+arrows for the other collides with seeking), so it is left for a change
  of its own.
