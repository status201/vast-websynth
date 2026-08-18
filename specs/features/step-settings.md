# Per-step settings & hit math (shared)

```yaml
id: step-settings
status: implemented
version: 3   # v3: per-step micro-timing — a step may sound early or late on its
             #     own cell (REQ-6..REQ-9), edited by a centre-detent slider
             #     bracketed by −/+ steppers
             # v2: the edit row's sliders are gesture-scoped (REQ-5)
owner: core
related:
  - architecture
  - sequencer
  - drum-machine
  - sampler
  - motion-sequencer
  - transport
  - meter
  - step-grid-editing
  - sidechain-ducking
  - render-to-sampler
  - untrusted-input
  - runtime-performance
  - ../decisions/adr-004-patternstore-separate-from-parambus
  - ../decisions/adr-006-no-op-param-defaults
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/audio/transport/step-hits.ts     # pure hit math
  - src/audio/transport/sequencer.ts     # the seq's own micro application
  - src/state/patterns.ts                # StepSettings shapes + defaults
  - src/state/limits.ts                  # MICRO_UNITS / MICRO_MAX
  - src/state/serialize.ts               # sparse encode (micro 0 is dropped)
  - src/audio/drums/drum-synths.ts       # chokeRoute (one-shot choke)
  - src/ui/components/step-settings.ts   # shared edit-row UI
  - src/ui/components/step-button.ts     # step-face viz
```

The velocity/gate/prob/ratchet/tie/micro model and the pure hit math shared by all
three step machines ([sequencer](sequencer.md), [drum machine](drum-machine.md),
[sampler](sampler.md)).

## Background / Why

Putting the per-step expressive controls and the probability/ratchet math in **one
pure module** means the three machines stay consistent and the tricky timing is
unit-testable without an `AudioContext`. The seq and the one-shot machines differ
only in how they *end* a hit: the sequencer releases its voice at `gateEnd`; the
one-shot machines use the **choke model** (a downstream gain cut), so the envelope
already scheduled inside the hit is never disturbed.

**Micro-timing** (v3) is the one per-step setting that moves a hit in *time* rather
than shaping it. Every groovebox has it — a snare pulled a few milliseconds behind
the beat is how a pattern stops sounding like a grid — and until v3 the only timing
control here was global [swing](transport.md), which offsets *every* off-beat by the
same amount. Micro is the per-step counterpart, and it deliberately reuses swing's
own bound and its own technique (an offset applied to the emitted `when`, never to
the grid), so the transport keeps a single monotonic 16th pulse and neither the
[clock](transport.md) nor the [meter](meter.md)'s lane math is touched at all.

## Requirements

- **REQ-1** — Every step carries `velocity, gate, prob, ratchet, tie` — and `micro`
  since v3 (REQ-6).
- **REQ-2** — `prob < 1` rolls per pass (`rollProb`); `ratchet` 1..4 evenly
  subdivides the step (`stepHits`).
- **REQ-3** — Seq: release the voice at `gateEnd`. One-shot: `gate < 1` cuts the
  hit at `gateEnd` via a downstream gain (`chokeAt`/`chokeRoute`); `gate == 1` is
  natural decay; `tie` on the last sub-hit rings into the next step (`holds`).
- **REQ-4** — Defaults (`TRIGGER_CELL_DEFAULTS`) make a plain `{on}` cell behave as
  before per-step settings existed (`gate 1`, `prob 1`, `ratchet 1`, `tie false`,
  `micro 0`).
- **REQ-5** — **The edit row's sliders are gesture-scoped** (v2). Each slider holds
  its `window` `pointermove`/`pointerup`/`pointercancel` listeners **only between
  pointerdown and pointerup/cancel**, exactly as `Knob` and `Strip` do
  ([add-a-ui-component](../recipes/add-a-ui-component.md),
  [runtime-performance](runtime-performance.md) REQ-3). This row is mounted three
  times over (seq / drum / sampler) with several sliders each, so a
  constructor-scoped handler here is not one stray listener but a dozen, every
  one running on every pointer move anywhere in the app. The track's box is
  measured **once per stroke** at pointerdown — re-reading it per move is a forced
  layout, and the slider cannot move mid-drag — and the fill is painted with
  `transform: scaleX()` rather than `width`, keeping the repaint on the
  compositor (the reason `GrMeter` does the same).

- **REQ-6** (v3) — **A step carries `micro`: a signed offset in 1/24 of its own
  cell.** `micro` is an **integer** in `-MICRO_MAX..+MICRO_MAX` (`±12`), where one
  notch is `1/MICRO_UNITS` (`1/24`) of the cell — a 1/384 note at the default lane
  rate, i.e. 96 PPQN, and ~5.2 ms at 120 BPM. Negative is early, positive is late.
  Integer, not a fraction: it is exact, it survives the sparse encoder's
  `EXPORT_SIG_FIGS` rounding untouched, and it is validated with a plain
  `Number.isInteger` range rather than a float epsilon.

  The unit is **1/24 and not 1/16** because 24 makes the musically interesting
  positions exactly reachable — `8/24` is a third of a step, so a hit can be placed
  *on* a triplet rather than near one. It is the same resolution Elektron's Micro
  Timing uses, which is the precedent
  ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 4).

  `micro` is a per-step *pattern* field, so it lives in `PatternStore`, not on the
  `ParamBus` ([ADR-004](../decisions/adr-004-patternstore-separate-from-parambus.md)).
  It defaults to **0**, so every preset, song and demo that predates it is
  bit-identical and no `SongFile` version bump is needed
  ([ADR-006](../decisions/adr-006-no-op-param-defaults.md); the same additive route
  [meter](meter.md) REQ-19 took).

  **Motion is excluded.** `MotionStep`/`MotionTrackStep` carry no `StepSettings`,
  and motion writes continuous parameter automation rather than events — "this
  anchor sounds 5 ms early" has no meaning when the value is interpolated between
  anchors every frame ([motion-sequencer](motion-sequencer.md)). The arpeggiator is
  excluded for the same structural reason: it has no per-step store at all.

- **REQ-7** (v3) — **The range is exactly half a cell, because that is the bound at
  which hits can meet but never cross.** With `|micro| <= 12/24`, step *n* pushed
  fully late and step *n+1* pulled fully early land on the *same* instant and never
  invert. Two existing guarantees depend on that and get it for free rather than
  needing new machinery:
  - [sidechain-ducking](sidechain-ducking.md)'s `Ducker.onDrumHit` drops any hit
    with `when < onset`, because cancelling an already-scheduled ramp for an
    earlier time strands the envelope mid-duck. Micro cannot produce such a hit
    within one lane, so a nudged kick still ducks.
  - The sequencer's mono voice release (REQ-8) stays correctly ordered against the
    attack it precedes.

  This is the same bound and the same reason as **swing**, which caps its delay at
  `0.5 * sixteenth` so an off-beat never crosses the next on-beat
  ([transport](transport.md) REQ-11). The two offsets compose additively and are
  independently bounded, so their sum can reach a full cell of spread across a pair
  of steps — still without inverting them, since swing delays only odd steps.
  A wider range (Elektron's ±23/24) was deliberately **not** taken: it can invert
  adjacent hits, which would turn both guarantees above into new code.

- **REQ-8** (v3) — **Micro is one pure offset, applied where the machines already
  meet.** `microOffset(step, cellDur)` in `step-hits.ts` is the single definition —
  the same "one definition, not two" rule `swingOffset` follows. It is applied at
  exactly two call sites:
  - `forEachActiveHit` adds it **inside** the lane loop (each lane's cell has its
    own `micro`), covering the drum machine and the sampler at once.
  - `Sequencer.tickTrack` computes it **explicitly**, because the sequencer needs
    the nudged time for more than the attack: the release of the *previous* mono
    note, the `stepHits` base and the note-viz emission must all move with it.
    Releasing at the un-nudged grid time while attacking early would cut the new
    note with the old note's release — the defect this requirement exists to pin.
    The tie-into-a-rest release keeps the plain grid time: a step that does not
    fire has no timing.

  `gateEnd`, `holds` and `chokeAt` all derive from the hit time, so gate, tie,
  ratchet and choke follow with no further change. Deliberately **not** offset: the
  **playhead** (`stepListeners.emit`), which tracks the grid the user sees, and the
  MIDI clock out, which is already blind to swing for the same reason
  ([midi-clock-sync](midi-clock-sync.md)).

  `clock.ts`, `lane-meter.ts` and `meter.ts` are **not touched**. A step with
  `micro === 0` costs one property read and one branch, and takes an early return
  before any arithmetic ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)
  — *cheap*).

- **REQ-9** (v3) — **An early offset is capped in absolute seconds, once, in the
  offset itself.** The clock emits a tick `SCHEDULE_AHEAD_S` (0.1 s) ahead at most
  and re-wakes every `LOOKAHEAD_MS` (25 ms), so the *guaranteed* lead on any tick is
  ~75 ms. An early offset larger than that would schedule into the past, where the
  downstream `Math.max(when, ctx.currentTime)` clamps (in `drum-synths.ts` and
  `sampler-machine.ts`) silently bunch hits onto *now* — the same shape as the burst
  [transport](transport.md) REQ-9 exists to prevent. `MAX_EARLY_S` (0.06 s) leaves
  15 ms of margin for timer jitter. Late offsets are uncapped; they are always
  schedulable.

  The consequence, stated rather than hidden: at **125 BPM and above** the full ±12
  range is exact (a 16th at 125 BPM is 120 ms, half of it is exactly 60 ms). Below
  that tempo — or on a lane running coarser than a 16th, whose cells are
  proportionally longer ([meter](meter.md) REQ-14) — the deepest *early* notches
  saturate at 60 ms rather than reaching a full half-cell. The cap lives in the pure
  offset function so it is testable without an `AudioContext` and so there is one
  place to change it, never in the ten downstream clamps.

## Technical design

### Contract / public interface (pure)

```yaml
step-hits.ts:
  StepHit: { t: number, gateEnd: number, holds: boolean }
  rollProb(prob, rng = Math.random): boolean         # true = fire this pass
  stepHits(s: {gate,ratchet,tie}, when, stepDur): StepHit[]
  chokeAt(s: {gate}, hit): number | undefined        # cut time, or undefined
  microOffset(s: {micro}, cellDur): number           # v3 — signed seconds, 0 when
                                                     # micro is 0; early capped
  MAX_EARLY_S = 0.06                                 # v3, REQ-9
limits.ts:
  MICRO_UNITS = 24    # notches per cell (1/384 note at the default rate)
  MICRO_MAX   = 12    # half a cell — the never-crosses bound (REQ-7)
drum-synths.ts:
  chokeRoute(ctx, output, chokeAt?): { dest, stopAt }  # downstream choke gain
```

### Data shapes

```yaml
StepSettings: { velocity, gate, prob, ratchet, tie, micro }
SeqStep:      StepSettings + { on, note }
TriggerCell:  StepSettings + { on }       # DrumCell / SamplerStep
TRIGGER_CELL_DEFAULTS: { on:false, velocity:.., gate:1, prob:1, ratchet:1,
                         tie:false, micro:0 }
micro: integer, -MICRO_MAX..+MICRO_MAX, units of 1/MICRO_UNITS of a CELL
       (not of a 16th — a lane at 1/8 nudges in 1/24 of its own longer cell)
```

### Gesture inventory — the Micro control

The edit row's own row of the [recipe](../recipes/design-an-interaction.md) step-1
artefact. The **grid cells** are untouched: their inventory is declared saturated by
[step-grid-editing](step-grid-editing.md), so micro takes no new cell gesture.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| − / + button | −1 / +1 notch | MPC nudge; every stepper |
| drag on the track | sweep, snapped to the 1/24 ladder | this app's other three sliders |
| left / right arrow (focused) | −1 / +1 notch | Elektron FUNC+arrows; DAW nudge |
| double-click | back to 0 | this app's knobs ([param-reset-baseline](param-reset-baseline.md)) |
| wheel | — (not taken; the grid's wheel is ±1 semitone) | — |
| long-press | — (nothing to inspect; the value is always on screen) | — |

The −/+ buttons are **not** redundant with the track. 25 notches across a slider
sized like its neighbours is a few pixels each, so the track can sweep but cannot
be *aimed*; and the arrow keys that can aim it are invisible until found, which
[ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1 rules out as the only
precise route. The buttons bracket the track rather than sitting at either end of
the row, so they read as belonging to it, and the readout still terminates the
control the way the unipolar sliders' percentage does.

The arrow keys are **scoped by focus, not by tab**: the slider is `tabindex="0"` and
its own `keydown` handler calls `preventDefault()` *and* `stopPropagation()`.
`shortcuts.ts` binds its global keys on `window` in the **bubble** phase and guards
only `isEditableTarget`, so an unstopped bare arrow would *also* shift the playable
keyboard's octave — one gesture, two outcomes, which
[ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 forbids. Stopping
propagation at the element keeps the fix local: `shortcuts.ts` is not modified.
`Home` is deliberately left alone — it is the transport's seek-to-top
([transport-position](transport-position.md)).

### Layer touchpoints

```yaml
consumers: sequencer.ts, drum-machine.ts, sampler-machine.ts all import step-hits
  sequencer.ts applies microOffset ITSELF (REQ-8); drum + sampler inherit it from
  forEachActiveHit, so neither machine file changes for micro
ui: src/ui/components/step-settings.ts (StepSettingsEditor) — shared edit row;
    each panel owns its own selection cursor. Step buttons visualise settings via
    StepButton.setViz() (gate width, velocity brightness, ratchet ticks, tie/prob,
    and micro as a horizontal shift of the fill layer — the hit visibly sits left
    or right in its cell)
    makeSlider grows { center, snap, format } rather than a second slider
    implementation, so REQ-5's drag discipline is inherited, not re-typed
testids: <seq|drum|sampler>-micro plus -micro-track / -dec / -inc / -value.
    Minted at the factory (makeSlider's `testid` option), because a positional
    selector into the row breaks the moment it grows a button — which it did.
migration: PatternStore.restore spreads TRIGGER_CELL_DEFAULTS UNDER incoming cells
    so legacy {on, velocity} cells gain the new fields (see song-mode.md).
    micro needs no other migration step and no format bump (REQ-6)
validation: song-validate.ts REFUSES a bad micro; song-author.ts COERCES it. The
    two must stay separate functions (ADR-013) — see the comment in song-validate.ts
```

## Scenarios (BDD)

```gherkin
Scenario: Ratchet subdivides a step into evenly spaced hits
  Given a step with ratchet 4 over stepDur d
  Then stepHits returns 4 hits at when + r*(d/4)
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: Probability gates a step (edge)
  Given prob 0.5 and an rng returning 0.7
  Then rollProb returns false and the step is skipped this pass
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: gate 1 means no choke, gate < 1 cuts early
  Given a one-shot hit with gate 1 -> chokeAt returns undefined (natural decay)
  And a hit with gate 0.5 and no tie -> chokeAt returns gateEnd
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: A slider holds no global listener at rest (REQ-5)
  Given a mounted edit row and no gesture in progress
  Then it has registered no pointermove listener on window
  When a pointerdown lands on a slider track
  Then the drag listeners attach, and pointerup (or pointercancel) removes every one
  And a pointermove after the stroke writes nothing
# pinned by: tests/ui/step-settings.test.ts

Scenario: A drag maps across the measured track box (REQ-5)
  Given a slider whose track spans 20..220px
  When the pointer presses at its midpoint and then drags past both ends
  Then the value is 0.5, then clamps to max, then to min
# pinned by: tests/ui/step-settings.test.ts

Scenario: micro 0 changes nothing at all (v3, REQ-6, regression)
  Given a step with micro 0
  Then microOffset returns exactly 0
  And its hit times are identical to those computed before micro existed
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: A step sounds early or late by 1/24 of its own cell (v3, REQ-6)
  Given a cell of duration d
  When micro is +6
  Then the hit lands at when + d/4
  And with micro -6 it lands at when - d/4
  And a lane whose cell is twice as long moves twice as far in seconds
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: Nudged neighbours can meet but never cross (v3, REQ-7, the invariant)
  Given step n at micro +12 and step n+1 at micro -12 at 125 BPM
  Then both land on the same instant
  And no pair of micro values within the range produces a later step sounding first
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: An early nudge is capped, a late one is not (v3, REQ-9, edge)
  Given a very slow tempo where half a cell exceeds MAX_EARLY_S
  When micro is -12
  Then the offset saturates at -MAX_EARLY_S rather than scheduling into the past
  And micro +12 at the same tempo is a full half-cell, uncapped
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: A nudged seq step releases the previous note at the nudged time (v3, REQ-8)
  Given a monophonic seq track whose step is on with micro -12
  When that step fires
  Then the previous note's release is scheduled at the nudged attack time
  And not at the un-nudged grid time, which would cut the new note
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: The playhead does not follow the nudge (v3, REQ-8, edge)
  Given a drum step with micro +12
  When its tick fires
  Then the step listener reports the cell on the grid, un-offset
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A legacy song has no micro and loads at 0 (v3, REQ-6, regression)
  Given a song file whose step cells carry no micro key
  When it is restored
  Then every step has micro 0 and sounds exactly as it did before v3
  And re-exporting it emits no micro key at all
# pinned by: tests/state/patterns.test.ts, tests/state/song.test.ts

Scenario: The Micro slider takes arrow keys without moving the octave (v3, REQ-9)
  Given the Micro slider has focus and the step's micro is 0
  When the right arrow key is pressed
  Then micro becomes +1
  And the event does not reach the global shortcut handler on window
  And a double-click on the track returns it to 0
# pinned by: tests/ui/step-settings.test.ts
```

## Tests & verification

- `tests/audio/transport/step-hits.test.ts` (pure — including the REQ-7 ordering
  invariant and the REQ-9 cap), `tests/audio/transport/sequencer.test.ts` (the
  nudged release), `tests/audio/transport/drum-machine.test.ts` (playhead not
  offset), `tests/state/patterns.test.ts` + `tests/state/song.test.ts` (default,
  migration, sparse round-trip), `tests/ui/step-settings.test.ts`
  (edit row + drag lifecycle + arrow-key isolation), `tests/ui/step-button.test.ts`
  (viz), `e2e/patterns.spec.ts` (grid + viz + clock advance).
- `npm test` / `npm run e2e` / `npm run typecheck`.
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)): nothing automated can
  tell you whether a nudge *feels* right. Mute every lane but kick and snare, run a
  straight two-bar pattern, and A/B the snare at `0`, `+3` and `-3`; `±12` should be
  obviously, deliberately drunk.

## Open questions / future

- New per-step fields go in `StepSettings` + `TRIGGER_CELL_DEFAULTS`; the
  defaults-spread-under migration keeps old songs valid.
- **[render-to-sampler](render-to-sampler.md) crops on the unswung grid**, so a
  micro-timed *first* or *last* cell of the rendered bar can fall outside the crop
  (an early first hit lands before the crop start, a late last hit after its end).
  Same class as the swing note already in `bankCropRange`, and left alone for the
  same reason: the bar length must stay exact.
- **The first step after `start()`** carries only 50 ms of lead
  (`nextStepTime = ctx.currentTime + 0.05`), which is less than `MAX_EARLY_S`, so a
  deep early nudge on it clamps to on-time. It is the step under the Play press;
  not worth re-origining the grid for.
- A **per-lane** shift (a DAW-style track delay, "the whole snare sits behind the
  beat") is the natural neighbour and would reuse `microOffset` wholesale. Not
  built: nudging the lane's steps covers it, and a second control needs its own
  storage and UI.
