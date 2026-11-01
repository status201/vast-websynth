# Per-step settings & hit math (shared)

```yaml
id: step-settings
status: implemented
version: 6
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
  - src/state/limits.ts                  # MICRO_UNITS / MICRO_MAX / BEND_MAX
  - src/state/serialize.ts               # sparse encode (micro 0 is dropped)
  - src/audio/drums/drum-synths.ts       # chokeRoute (one-shot choke)
  - src/audio/note-bend.ts               # schedules a bend on a voice's bend param
  - src/audio/voice.ts                   # the per-voice bend source
  - src/ui/components/step-settings.ts   # shared edit-row UI
  - src/ui/components/step-button.ts
  - src/ui/onboarding/help-content.ts    # the seq.bend help topic
```

The velocity/gate/prob/ratchet/tie/micro model and the pure hit math shared by the
[sequencer](sequencer.md), [drum machine](drum-machine.md) and [sampler](sampler.md),
plus the sequencer-only per-step bend.

## Background / Why

One **pure module** keeps the three machines consistent and the timing testable
without an `AudioContext`. They differ only in how a hit *ends*: the sequencer
releases its voice at `gateEnd`, and the one-shot machines use the **choke model** (a
downstream gain cut), so the envelope scheduled inside the hit is never disturbed.
**Micro-timing** is the per-step counterpart of global [swing](transport.md), with
swing's bound and technique: an offset on the emitted `when`, never on the grid. So
neither the clock nor the [meter](meter.md) is touched. **Pitch bend** bends one note
inside itself, unlike tie + glide (into the next note, mono only) or
`master.pitchBend` (every voice). The vocabulary is the guitarist's and singer's: a
signed amount and a *scoop* (arrive) or *fall* (leave). The written `note` stays the
pitch the step means: highlighted, quantized and transposed.

## Requirements

- **REQ-every-step-carries-its-settings** — Every step carries `velocity, gate, prob,
  ratchet, tie, micro`.
- **REQ-probability-rolls-and-ratchet-repeats** — `prob < 1` rolls per pass
  (`rollProb`); `ratchet` 1..4 evenly subdivides the step (`stepHits`).
- **REQ-gate-releases-or-cuts** — Seq: release the voice at `gateEnd`. One-shot:
  `gate < 1` cuts at `gateEnd` via a downstream gain (`chokeAt`/`chokeRoute`), and
  `gate == 1` is natural decay. `tie` on the last sub-hit rings into the next step
  (`holds`).
- **REQ-a-default-cell-behaves-as-before** — `TRIGGER_CELL_DEFAULTS` make a plain
  `{on}` cell a plain hit (`gate 1`, `prob 1`, `ratchet 1`, `tie false`, `micro 0`).
- **REQ-edit-sliders-are-gesture-scoped** — Each slider holds its `window`
  `pointermove`/`pointerup`/`pointercancel` listeners **only between pointerdown and
  pointerup/cancel**, like `Knob` and `Strip`
  ([runtime-performance](runtime-performance.md)
  REQ-global-listeners-live-only-for-a-gesture). The row is mounted three times with
  several sliders each. The track box is measured **once per stroke**, and the fill
  moves by `transform: scaleX()`, not `width`.
- **REQ-a-step-carries-a-micro-offset** — `micro` is an **integer** in
  `-MICRO_MAX..+MICRO_MAX` (±12), one notch being `1/MICRO_UNITS` (1/24) of the
  step's own **cell**: 96 PPQN at the default rate, ~5.2 ms at 120 BPM. Negative is
  early. It is an integer so it is exact, survives sparse rounding, and validates with
  `Number.isInteger`. 1/24 makes a triplet exactly reachable (`8/24`), the Elektron
  Micro Timing precedent (ADR-014 law 4). It lives in `PatternStore` (ADR-004) and
  defaults to 0, so no format bump (ADR-006; [meter](meter.md)
  REQ-meter-needs-no-song-file-bump). **Motion is excluded** (interpolated
  automation has no "5 ms early"), and so is the arpeggiator (no per-step store).
- **REQ-micro-range-is-half-a-cell** — With `|micro| ≤ 12/24`, adjacent hits can
  meet but **never cross**. [sidechain-ducking](sidechain-ducking.md)'s
  `Ducker.onDrumHit` drops `when < onset`, and the sequencer's mono release stays
  ordered against the next attack. Both get that for free. Swing's own bound is half
  a 16th ([transport](transport.md) REQ-swing-offset-is-public). The two compose
  additively without inverting, since swing delays only odd steps. Elektron's ±23/24
  was rejected because it can invert hits.
- **REQ-micro-is-one-pure-offset** — `microOffset(step, cellDur)` in `step-hits.ts`
  is the single definition. It is applied in two places:
  - `forEachActiveHit` adds it inside the lane loop (drum machine and sampler);
  - `Sequencer.tickTrack` computes it **explicitly**, because the previous mono
    note's release, the `stepHits` base and the note viz must all move with it. An
    un-nudged release would cut the early attack. A tie-into-a-rest release keeps
    grid time.

  `gateEnd`, `holds` and `chokeAt` derive from the hit time, so they follow. **Not**
  offset: the playhead (`stepListeners.emit`) and the MIDI clock. `clock.ts`,
  `lane-meter.ts` and `meter.ts` are untouched. `micro === 0` costs one read and one
  branch (ADR-010).
- **REQ-an-early-offset-is-capped-in-seconds** — The clock guarantees ~75 ms of lead
  (`SCHEDULE_AHEAD_S` 0.1 s, re-woken every 25 ms). So an early offset is capped at
  `MAX_EARLY_S` (0.06 s) in the offset itself, or the downstream `Math.max(when,
  currentTime)` clamps would bunch hits onto *now* ([transport](transport.md)
  REQ-the-transport-catch-up-is-bounded). Late offsets are uncapped. At **125 BPM and
  above** the full ±12 is exact; below it, or on a coarser lane, the deepest early
  notches saturate at 60 ms.
- **REQ-a-seq-step-carries-a-bend** — `bend`, a signed **integer** in
  `-BEND_MAX..+BEND_MAX` (±12, `limits.ts`), and `bendShape`, `'scoop' | 'fall'`
  (a word, readable in a song file). **`bend 0` is a no-op** and the default; the
  shape is inert until an amount is set (ADR-006). Both join `SEQ_EXTRA_DEFAULTS`, and
  the sparse encoder drops each at its default, so no format bump. **Seq only**: drum
  and sampler slots have no pitched voice to bend. The canonical validator
  range-checks them only on a seq step, and a trigger cell carrying them is tolerated,
  never read, and dropped on export.
- **REQ-bend-shapes-are-scoop-and-fall** — For a hit at `t` with gate end `gateEnd`,
  the bend runs for `dur = BEND_FRACTION * (gateEnd - t)` (0.5), as a **linear ramp in
  cents** (exponential in Hz, like a bent string). **scoop**: starts `bend` semitones
  away and reaches the note by `t + dur`. **fall**: starts on the note, reaches `bend`
  away by `t + dur` and **holds** until release. A fraction of the gate keeps the bend
  inside the sounding note.
- **REQ-a-bend-is-per-voice** — Each `Voice` owns a `ConstantSourceNode` (`noteBend`,
  cents) on `osc1`/`osc2`/`sub` detune, summing with `master.pitchBend`. Modulation
  stays in the graph (ADR-017): only the events one note-on schedules. Unison copies
  bend identically, and other voices do not move. It rides `NoteOptions.bend` (`{
  semis, shape, dur }`), the channel `pan` uses, so the arp, keyboard and MIDI are
  untouched. One node per voice, built at boot, idle at 0.
- **REQ-a-bend-zero-schedules-nothing** — A voice remembers whether its bend source
  may be away from 0. A no-bend note on a clean voice writes **no event at all**. A
  no-bend note after a bent one does an anchored reset (`cancelScheduledValues(when)` +
  `setValueAtTime(0, when)`), so a reused voice never inherits a fall. A bent note
  cancels, pins its start at `when` and ramps (ADR-027,
  `tests/audio/no-unanchored-cancel.test.ts`).
- **REQ-every-sub-hit-re-bends** — Each ratchet sub-hit gets its own bend over its own
  sub-gate. A tied fall holds only until the next step attacks with its own bend; a
  next step at bend 0 returns to the written pitch. The step that sounds defines the
  pitch.

## Technical design

### Contract / public interface (pure)

```yaml
step-hits.ts:
  StepHit: { t: number, gateEnd: number, holds: boolean }
  rollProb(prob, rng = Math.random): boolean         # true = fire this pass
  stepHits(s: {gate,ratchet,tie}, when, stepDur): StepHit[]
  chokeAt(s: {gate}, hit): number | undefined        # cut time, or undefined
  microOffset(s: {micro}, cellDur): number           # signed seconds; 0 at micro 0; early capped
  MAX_EARLY_S = 0.06
  stepBend(s: {bend,bendShape}, hit): NoteBend | undefined   # undefined at bend 0
  BEND_FRACTION = 0.5
note-output.ts:
  NoteOptions.bend?: NoteBend                        # { semis, shape, dur }
note-bend.ts:
  scheduleBend(param, bend: NoteBend | undefined, when, dirty): boolean
    # writes the scoop/fall events (anchored); returns the new "dirty" flag
limits.ts:
  BEND_MAX    = 12    # semitones either way
  MICRO_UNITS = 24    # notches per cell
  MICRO_MAX   = 12    # half a cell — the never-crosses bound
drum-synths.ts:
  chokeRoute(ctx, output, chokeAt?): { dest, stopAt }  # downstream choke gain
```

### Data shapes

```yaml
StepSettings: { velocity, gate, prob, ratchet, tie, micro }
SeqStep:      StepSettings + { on, note, bend, bendShape }
TriggerCell:  StepSettings + { on }       # DrumCell / SamplerStep
TRIGGER_CELL_DEFAULTS: { on:false, velocity:.., gate:1, prob:1, ratchet:1,
                         tie:false, micro:0 }
micro: integer, -MICRO_MAX..+MICRO_MAX, units of 1/MICRO_UNITS of a CELL
bend: integer, -BEND_MAX..+BEND_MAX semitones; 0 = no bend (default)
bendShape: 'scoop' | 'fall'; default 'scoop'; inert while bend is 0
NoteBend: { semis: number, shape: 'scoop' | 'fall', dur: seconds }
```

### Gesture inventory — the Bend controls (seq panel only)

| Control | Gesture | Outcome | Precedent |
| --- | --- | --- | --- |
| Bend slider | − / + button | −1 / +1 semitone | the Micro stepper beside it |
| Bend slider | drag on the track | sweep, snapped to whole semitones | Micro |
| Bend slider | left / right arrow (focused) | −1 / +1 semitone | Micro |
| Bend slider | double-click | back to 0 (no bend) | Micro; the knobs |
| Scoop / Fall | click a button | that shape is the step's shape | the Ratchet 1–4 group |
| either | wheel, long-press | — (not taken, as for Micro) | — |

The Bend slider uses the Micro slider's factory (`makeSlider` with `center`,
`stepper`, `snap`, `keyStep`, `resetTo`), so drag lifecycle, key isolation and testids
are inherited. The shape is two labelled word buttons, not a toggle ("fall" is not
"scoop off"). They are dimmed while `bend` is 0 but still editable.

### Gesture inventory — the Micro control

The grid cells take no new gesture (their inventory is saturated,
[step-grid-editing](step-grid-editing.md)).

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| − / + button | −1 / +1 notch | MPC nudge; every stepper |
| drag on the track | sweep, snapped to the 1/24 ladder | this app's other sliders |
| left / right arrow (focused) | −1 / +1 notch | Elektron FUNC+arrows; DAW nudge |
| double-click | back to 0 | this app's knobs ([param-reset-baseline](param-reset-baseline.md)) |
| wheel | — (not taken; the grid's wheel is ±1 semitone) | — |
| long-press | — (the value is always on screen) | — |

25 notches across a slider are a few pixels each, so the −/+ buttons are what aims it
(ADR-014 law 1). The arrows are **scoped by focus**: the slider is `tabindex="0"`, and
its `keydown` calls `preventDefault()` *and* `stopPropagation()`. Otherwise
`shortcuts.ts`'s bubble-phase Shift+arrow would also seek a bar
([transport-position](transport-position.md) REQ-home-and-shift-arrows-seek): one
gesture, two outcomes (law 2). That is the rule every focused knob follows
([knob-keyboard-access](knob-keyboard-access.md)). `Home` is left to the transport.

### Layer touchpoints

```yaml
consumers: sequencer.ts, drum-machine.ts, sampler-machine.ts all import step-hits
  sequencer.ts applies microOffset ITSELF; drum + sampler inherit it from forEachActiveHit
ui: src/ui/components/step-settings.ts (StepSettingsEditor) — shared edit row;
    each panel owns its own selection cursor. StepButton.setViz() shows gate width,
    velocity brightness, ratchet ticks, tie/prob, micro as a horizontal shift of the
    fill, and a bend direction stroke in the lower corner (::before; ::after is ratchet)
    makeSlider grows { center, snap, format } rather than a second slider implementation
bend: sequencer.ts computes stepBend(s, h) per sub-hit -> NoteOptions -> Polyphony
    -> Voice.noteOn -> scheduleBend on voice.noteBend.offset. The editor's optional
    `bend` get/set pair is passed by the seq panel only.
testids: seq-bend plus -track / -dec / -inc / -value; seq-bend-scoop, seq-bend-fall;
    <seq|drum|sampler>-micro plus -micro-track / -dec / -inc / -value
    (minted by makeSlider's `testid`, never positional)
migration: PatternStore.restore spreads TRIGGER_CELL_DEFAULTS (and SEQ_EXTRA_DEFAULTS)
    UNDER incoming cells (song-mode.md)
validation: song-validate.ts REFUSES a bad micro/bend; song-author.ts COERCES it.
    They stay separate functions (ADR-013)
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

Scenario: A slider holds no global listener at rest (REQ-edit-sliders-are-gesture-scoped)
  Given a mounted edit row and no gesture in progress
  Then it has registered no pointermove listener on window
  When a pointerdown lands on a slider track
  Then the drag listeners attach, and pointerup (or pointercancel) removes every one
  And a pointermove after the stroke writes nothing
# pinned by: tests/ui/step-settings.test.ts

Scenario: A drag maps across the measured track box (REQ-edit-sliders-are-gesture-scoped)
  Given a slider whose track spans 20..220px
  When the pointer presses at its midpoint and then drags past both ends
  Then the value is 0.5, then clamps to max, then to min
# pinned by: tests/ui/step-settings.test.ts

Scenario: micro 0 changes nothing at all (REQ-a-step-carries-a-micro-offset, regression)
  Given a step with micro 0
  Then microOffset returns exactly 0
  And its hit times are identical to the un-nudged ones
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: A step sounds early or late by 1/24 of its own cell (REQ-a-step-carries-a-micro-offset)
  Given a cell of duration d
  When micro is +6
  Then the hit lands at when + d/4
  And with micro -6 it lands at when - d/4
  And a lane whose cell is twice as long moves twice as far in seconds
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: Nudged neighbours can meet but never cross (REQ-micro-range-is-half-a-cell, the invariant)
  Given step n at micro +12 and step n+1 at micro -12 at 125 BPM
  Then both land on the same instant
  And no pair of micro values within the range produces a later step sounding first
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: An early nudge is capped, a late one is not (REQ-an-early-offset-is-capped-in-seconds, edge)
  Given a very slow tempo where half a cell exceeds MAX_EARLY_S
  When micro is -12
  Then the offset saturates at -MAX_EARLY_S rather than scheduling into the past
  And micro +12 at the same tempo is a full half-cell, uncapped
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: A nudged seq step releases the previous note at the nudged time (REQ-micro-is-one-pure-offset)
  Given a monophonic seq track whose step is on with micro -12
  When that step fires
  Then the previous note's release is scheduled at the nudged attack time
  And not at the un-nudged grid time, which would cut the new note
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: The playhead does not follow the nudge (REQ-micro-is-one-pure-offset, edge)
  Given a drum step with micro +12
  When its tick fires
  Then the step listener reports the cell on the grid, un-offset
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A legacy song has no micro and loads at 0 (REQ-a-step-carries-a-micro-offset, regression)
  Given a song file whose step cells carry no micro key
  When it is restored
  Then every step has micro 0 and sounds exactly as it did
  And re-exporting it emits no micro key at all
# pinned by: tests/state/patterns.test.ts, tests/state/song.test.ts

Scenario: The Micro slider takes arrow keys without reaching the global shortcuts (gesture inventory)
  Given the Micro slider has focus and the step's micro is 0
  When the right arrow key is pressed
  Then micro becomes +1
  And the event does not reach the global shortcut handler on window
  And a double-click on the track returns it to 0
# pinned by: tests/ui/step-settings.test.ts

Scenario: bend 0 schedules nothing (REQ-a-bend-zero-schedules-nothing, regression)
  Given a seq step with bend 0
  Then stepBend returns undefined
  And scheduleBend on a clean param writes no automation event at all
# pinned by: tests/audio/transport/step-hits.test.ts, tests/audio/note-bend.test.ts

Scenario: A scoop arrives at the note (REQ-bend-shapes-are-scoop-and-fall)
  Given a hit at t with gate end t + 0.2 and a step with bend -2, shape scoop
  Then the bend's duration is 0.1 (BEND_FRACTION of the gate)
  And the bend param is pinned at -200 cents at t and ramps linearly to 0 by t + 0.1
# pinned by: tests/audio/transport/step-hits.test.ts, tests/audio/note-bend.test.ts

Scenario: A fall leaves the note and holds (REQ-bend-shapes-are-scoop-and-fall)
  Given a step with bend +12, shape fall
  Then the bend param is pinned at 0 at t and ramps to +1200 cents by t + dur
  And no later event returns it to 0 before the next note-on
# pinned by: tests/audio/note-bend.test.ts

Scenario: A reused voice does not inherit a fall (REQ-a-bend-zero-schedules-nothing, edge)
  Given a voice whose last note fell +12
  When it plays a note with no bend
  Then the bend param is cancelled from the new attack and pinned at 0 there
  And a further unbent note writes nothing
# pinned by: tests/audio/note-bend.test.ts

Scenario: The sequencer bends each sub-hit and only the bent step (REQ-every-sub-hit-re-bends, REQ-a-bend-is-per-voice)
  Given a seq step with bend -1, shape scoop, ratchet 2
  When it fires
  Then both playNote calls carry a bend whose dur is BEND_FRACTION of that sub-hit's gate
  And a neighbouring step with bend 0 is played with no bend at all
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A legacy song has no bend and re-exports byte-identical (REQ-a-seq-step-carries-a-bend, regression)
  Given a song file whose seq steps carry no bend or bendShape key
  When it is restored
  Then every seq step has bend 0 and bendShape 'scoop'
  And re-exporting it emits neither key
  And a step with bend -3, shape fall round-trips exactly
# pinned by: tests/state/song.test.ts

Scenario: An out-of-range bend is refused, and coerced in the dialect (REQ-a-seq-step-carries-a-bend, edge)
  Given a canonical seq step with bend 13, or 1.5, or bendShape 'wobble'
  Then the canonical validator refuses the file
  And the authoring dialect reports the field and imports the rest of the song
# pinned by: tests/state/song-validate.test.ts, tests/state/song-author.test.ts

Scenario: The Bend controls edit the selected seq step (gesture inventory)
  Given the seq edit row with a step selected
  When + is pressed twice on the Bend slider and Fall is clicked
  Then the step has bend 2 and bendShape 'fall'
  And the drum and sampler edit rows have no Bend controls
# pinned by: tests/ui/step-settings.test.ts
```

## Tests & verification

- `tests/audio/transport/step-hits.test.ts` (pure: the ordering invariant and the
  early cap), `tests/audio/transport/sequencer.test.ts`,
  `tests/audio/transport/drum-machine.test.ts`, `tests/audio/note-bend.test.ts`
  (against a recording param, since the mock keeps no event list),
  `tests/state/{patterns,song,song-validate,song-author}.test.ts`,
  `tests/ui/step-settings.test.ts`, `tests/ui/step-button.test.ts`,
  `e2e/patterns.spec.ts` — `npm test` / `npm run e2e`.
- **By ear** (ADR-010, [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)):
  kick + snare only, A/B the snare at micro `0`, `+3`, `-3` (±12 should be
  deliberately drunk). Bend: a mono line with a scoop `-2` and a fall `+12`, A/B'd at
  bend 0, through `npm run bench:audio` **and** `--browser firefox` (AudioParam
  automation). A scoop should sing into the note, and a fall should finish inside the
  gate.

## Open questions / future

- A new per-step field for every machine goes in `StepSettings` +
  `TRIGGER_CELL_DEFAULTS`; a seq-only one in `SeqStep` + `SEQ_EXTRA_DEFAULTS`. The
  defaults-spread-under migration keeps old songs valid.
- [render-to-sampler](render-to-sampler.md) crops on the unswung grid, so a
  micro-timed first or last cell can fall outside the crop. Left alone: the bar length
  must stay exact.
- The first step after `start()` has only 50 ms of lead, under `MAX_EARLY_S`, so a
  deep early nudge on it clamps to on-time. A dropout re-origins with
  `DROPOUT_LEAD_S` (0.1 s) ([transport](transport.md)). The choke moves with a
  clamped start ([drum-machine](drum-machine.md) REQ-a-clamped-hit-carries-its-choke,
  [sampler](sampler.md) REQ-a-slot-starts-from-zero), so the gate keeps its length.
- Bend, not built yet: a per-step bend *time*, a drawn pitch curve, sampler bend
  through `playbackRate`, bend as a bank-level dialect default.
- A **per-lane** shift (a track delay) would reuse `microOffset`. Nudging the lane's
  steps covers it.
