# Wheel steps (a scroll gesture moves a stepped value by notches, not by events)

```yaml
id: wheel-steps
status: implemented
version: 1
owner: core
related:
  - arrangement          # wheel over a chain chip: ±1 semitone (the gesture inventory's row)
  - step-grid-editing    # wheel over a seq step: ±1 semitone
  - sequencer            # the note display's scroll-to-change
source:
  - src/ui/wheel-steps.ts
  - src/ui/panels/song-panel.ts   # the chain chip's transpose
  - src/ui/panels/seq-panel.ts    # the step button and the note display
```

One rule for turning a `wheel` gesture into whole steps of a stepped value — a
semitone, today — shared by every control that has one, so a mouse and a touchpad
move it by the same amount for the same intent.

## Background / Why

Three controls moved their value by one semitone **per `wheel` event**: the Song
tab's chain chip (transpose), and on the Sequencer tab the step buttons and the
note display (pitch). That is right for a mouse, which sends one event per notch.
A touchpad does not: it sends a stream of small-delta events — dozens for one
gentle swipe — so the same "one more" gesture moved a note or a bar's transpose
by ten to thirty semitones, straight to the clamp. The XY pad already scales its
wheel by the delta and was never affected; the stepped controls could not simply
copy it, because they move in whole steps.

## Requirements

- **REQ-a-wheel-gesture-steps-by-distance** — **A stepped value moves one step
  per notch of scrolling, not per event.** `createWheelStepper()` turns each
  `wheel` event into `+1`, `-1` or `0`:
  - The **first event of a gesture** — after `WHEEL_IDLE_MS` (200 ms) of quiet,
    or when the direction flips — steps **at once**. So a single mouse notch
    still moves exactly one semitone, however small a delta the platform
    reports for it (macOS reports a few pixels; Windows about a hundred).
  - After that the distance **accumulates** and steps every `WHEEL_NOTCH_PX`
    (40 px) — **at most one step per event**, so a mouse wheel spun quickly still
    moves one semitone per notch and a touchpad swipe moves in proportion to how
    far it travels.
  - `deltaMode` is normalised first: lines count 16 px each, pages 400 px.
  - Scrolling up (negative `deltaY`) is `+1`, matching what the three controls
    did before.
  Each caller still owns what a step *does*, and still calls `preventDefault`
  (the page must not scroll under the control). One stepper per control, so two
  controls never share an accumulator.

## Technical design

```ts
// src/ui/wheel-steps.ts
export const WHEEL_NOTCH_PX = 40;
export const WHEEL_IDLE_MS = 200;
export function createWheelStepper(now?: () => number): (e: WheelEvent) => -1 | 0 | 1;
```

## Scenarios (BDD)

```gherkin
Scenario: A mouse notch moves one semitone (REQ-a-wheel-gesture-steps-by-distance)
  Given a stepper that has been idle
  When one wheel event arrives, of any size — 4 px or 100 px, up
  Then it steps +1
# pinned by: tests/ui/wheel-steps.test.ts

Scenario: A touchpad swipe moves in proportion, not per event (REQ-a-wheel-gesture-steps-by-distance, regression)
  Given a stepper that has been idle
  When 30 events of 4 px each arrive 10 ms apart, all down
  Then it steps -1 on the first and once per further 40 px — 3 in all, not 30
# pinned by: tests/ui/wheel-steps.test.ts

Scenario: A fast mouse spin never skips notches (REQ-a-wheel-gesture-steps-by-distance, edge)
  Given events of 100 px each, 20 ms apart
  Then each one steps exactly once
# pinned by: tests/ui/wheel-steps.test.ts

Scenario: A pause or a reversal starts a new gesture (REQ-a-wheel-gesture-steps-by-distance, edge)
  Given a stepper mid-gesture with distance accumulated
  When the next event comes after 200 ms of quiet, or in the other direction
  Then it steps at once in its own direction, the old distance forgotten
# pinned by: tests/ui/wheel-steps.test.ts

Scenario: Every stepped wheel control uses it (REQ-a-wheel-gesture-steps-by-distance)
  Given the chain chip, the seq step button and the seq note display
  Then each drives its semitone through a stepper, not through the event count
# pinned by: tests/ui/wheel-steps.test.ts
```

## Tests & verification

- `tests/ui/wheel-steps.test.ts`.
- By hand, on a touchpad and on a mouse: one small swipe or one notch over a
  chain chip or a seq step moves it about a semitone.
