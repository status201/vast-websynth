# Per-step settings & hit math (shared)

```yaml
id: step-settings
status: implemented
version: 6   # v6: the "new per-step fields" note names the seq-only home bend used
             # v5: per-step pitch bend on SEQ steps — a signed semitone amount and a
             #     scoop/fall shape, played on a per-voice detune source
             #     (REQ-a-seq-step-carries-a-bend..REQ-every-sub-hit-re-bends)
             # v4: the past-clamp note below understated the damage — the choke
             #     did NOT clamp with the hit (drum-machine.md REQ-a-clamped-hit-carries-its-choke)
             # v3: per-step micro-timing — a step may sound early or late on its
             #     own cell (REQ-a-step-carries-a-micro-offset … REQ-an-early-offset-is-capped-in-seconds), edited by a centre-detent slider
             #     bracketed by −/+ steppers
             # v2: the edit row's sliders are gesture-scoped (REQ-edit-sliders-are-gesture-scoped)
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
  - src/audio/note-bend.ts               # v5 — schedules a bend on a voice's bend param
  - src/audio/voice.ts                   # v5 — the per-voice bend source
  - src/ui/components/step-settings.ts   # shared edit-row UI
  - src/ui/components/step-button.ts     # step-face viz (v5: the bend stroke)
  - src/ui/onboarding/help-content.ts    # v5 — the seq.bend help topic
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

**Pitch bend** (v5) is the one per-step setting that bends a note *inside* itself.
Before v5 a sequenced note could only reach another pitch through tie + glide —
the 303 slide, which moves *into the next step's* note and only in mono — or
through `master.pitchBend`, which is one detune source wired into every voice, so
automating it on a [motion](motion-sequencer.md) track bends the whole chord and
not the one note. How other sequencers answer the same need:

| Device | Model |
| --- | --- |
| Roland TB-303 and clones | per-step Slide into the next note — what `tie` already is here |
| Elektron (Analog Four, Digitone, Syntakt) | slide trigs, plus parameter locks: any parameter, pitch included, locked per step |
| Trackers (Renoise, FastTracker, Polyend Tracker) | an effect column per row: portamento up/down at a rate, tone-porta, vibrato |
| Ableton 11+, Bitwig (MPE) | a pitch curve drawn on each note in the piano roll |

The model taken is the bend-in / fall-off vocabulary guitar and vocal phrasing
already use: a signed **amount** in semitones and one of two **shapes**. A *scoop*
starts off-pitch and settles onto the written note; a *fall* starts on the note and
bends away from it. The written `note` stays the pitch the step *means* — the one
the keyboard highlights, the [scale](sequencer.md) quantizes and the
[arrangement](arrangement.md) transposes — and the bend is an ornament on top of
it, in the same additive semitone space the rest of the app modulates pitch in
([ADR-005](../decisions/adr-005-cutoff-as-midi-note.md)'s habit). Two small fields
fit the existing edit row; a tracker column would be cryptic there and a drawn
curve needs an editor the row has no room for.

## Requirements

- **REQ-every-step-carries-its-settings** — Every step carries `velocity, gate,
  prob, ratchet, tie` — and `micro` since v3
  (REQ-a-step-carries-a-micro-offset).
- **REQ-probability-rolls-and-ratchet-repeats** — `prob < 1` rolls per pass
  (`rollProb`); `ratchet` 1..4 evenly subdivides the step (`stepHits`).
- **REQ-gate-releases-or-cuts** — Seq: release the voice at `gateEnd`. One-shot:
  `gate < 1` cuts the hit at `gateEnd` via a downstream gain
  (`chokeAt`/`chokeRoute`); `gate == 1` is natural decay; `tie` on the last
  sub-hit rings into the next step (`holds`).
- **REQ-a-default-cell-behaves-as-before** — Defaults (`TRIGGER_CELL_DEFAULTS`)
  make a plain `{on}` cell behave as before per-step settings existed (`gate 1`,
  `prob 1`, `ratchet 1`, `tie false`, `micro 0`).
- **REQ-edit-sliders-are-gesture-scoped** — **The edit row's sliders are
  gesture-scoped** (v2). Each slider holds its `window`
  `pointermove`/`pointerup`/`pointercancel` listeners **only between pointerdown
  and pointerup/cancel**, exactly as `Knob` and `Strip` do
  ([add-a-ui-component](../recipes/add-a-ui-component.md),
  [runtime-performance](runtime-performance.md) REQ-global-listeners-live-only-for-a-gesture). This row is mounted
  three times over (seq / drum / sampler) with several sliders each, so a
  constructor-scoped handler here is not one stray listener but a dozen, every
  one running on every pointer move anywhere in the app. The track's box is
  measured **once per stroke** at pointerdown — re-reading it per move is a
  forced layout, and the slider cannot move mid-drag — and the fill is painted
  with `transform: scaleX()` rather than `width`, keeping the repaint on the
  compositor (the reason `GrMeter` does the same).

- **REQ-a-step-carries-a-micro-offset** (v3) — **A step carries `micro`: a
  signed offset in 1/24 of its own cell.** `micro` is an **integer** in
  `-MICRO_MAX..+MICRO_MAX` (`±12`), where one notch is `1/MICRO_UNITS` (`1/24`)
  of the cell — a 1/384 note at the default lane rate, i.e. 96 PPQN, and ~5.2 ms
  at 120 BPM. Negative is early, positive is late. Integer, not a fraction: it
  is exact, it survives the sparse encoder's `EXPORT_SIG_FIGS` rounding
  untouched, and it is validated with a plain `Number.isInteger` range rather
  than a float epsilon.

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
  [meter](meter.md) REQ-meter-needs-no-song-file-bump took).

  **Motion is excluded.** `MotionStep`/`MotionTrackStep` carry no `StepSettings`,
  and motion writes continuous parameter automation rather than events — "this
  anchor sounds 5 ms early" has no meaning when the value is interpolated between
  anchors every frame ([motion-sequencer](motion-sequencer.md)). The arpeggiator is
  excluded for the same structural reason: it has no per-step store at all.

- **REQ-micro-range-is-half-a-cell** (v3) — **The range is exactly half a cell,
  because that is the bound at
  which hits can meet but never cross.** With `|micro| <= 12/24`, step *n* pushed
  fully late and step *n+1* pulled fully early land on the *same* instant and never
  invert. Two existing guarantees depend on that and get it for free rather than
  needing new machinery:
  - [sidechain-ducking](sidechain-ducking.md)'s `Ducker.onDrumHit` drops any hit
    with `when < onset`, because cancelling an already-scheduled ramp for an
    earlier time strands the envelope mid-duck. Micro cannot produce such a hit
    within one lane, so a nudged kick still ducks.
  - The sequencer's mono voice release (REQ-micro-is-one-pure-offset) stays correctly ordered against the
    attack it precedes.

  This is the same bound and the same reason as **swing**, which caps its delay at
  `0.5 * sixteenth` so an off-beat never crosses the next on-beat
  ([transport](transport.md) REQ-swing-offset-is-public). The two offsets compose additively and are
  independently bounded, so their sum can reach a full cell of spread across a pair
  of steps — still without inverting them, since swing delays only odd steps.
  A wider range (Elektron's ±23/24) was deliberately **not** taken: it can invert
  adjacent hits, which would turn both guarantees above into new code.

- **REQ-micro-is-one-pure-offset** (v3) — **Micro is one pure offset, applied
  where the machines already meet.** `microOffset(step, cellDur)` in
  `step-hits.ts` is the single definition — the same "one definition, not two"
  rule `swingOffset` follows. It is applied at exactly two call sites:
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

- **REQ-an-early-offset-is-capped-in-seconds** (v3) — **An early offset is
  capped in absolute seconds, once, in the offset itself.** The clock emits a
  tick `SCHEDULE_AHEAD_S` (0.1 s) ahead at most and re-wakes every
  `LOOKAHEAD_MS` (25 ms), so the *guaranteed* lead on any tick is ~75 ms. An
  early offset larger than that would schedule into the past, where the
  downstream `Math.max(when, ctx.currentTime)` clamps (in `drum-synths.ts` and
  `sampler-machine.ts`) silently bunch hits onto *now* — the same shape as the
  burst [transport](transport.md) REQ-the-transport-catch-up-is-bounded exists to prevent. `MAX_EARLY_S` (0.06
  s) leaves 15 ms of margin for timer jitter. Late offsets are uncapped; they
  are always schedulable.

  The consequence, stated rather than hidden: at **125 BPM and above** the full ±12
  range is exact (a 16th at 125 BPM is 120 ms, half of it is exactly 60 ms). Below
  that tempo — or on a lane running coarser than a 16th, whose cells are
  proportionally longer ([meter](meter.md) REQ-each-machine-has-a-step-rate) — the deepest *early* notches
  saturate at 60 ms rather than reaching a full half-cell. The cap lives in the pure
  offset function so it is testable without an `AudioContext` and so there is one
  place to change it, never in the ten downstream clamps.

- **REQ-a-seq-step-carries-a-bend** (v5) — **A sequencer step carries `bend` and
  `bendShape`.** `bend` is a signed **integer** number of semitones in
  `-BEND_MAX..+BEND_MAX` (`±12`, `limits.ts`); `bendShape` is `'scoop'` or
  `'fall'`. Integer for `micro`'s reasons: exact, untouched by the sparse
  encoder's `EXPORT_SIG_FIGS` rounding, validated with a plain `Number.isInteger`
  range. An octave either way covers the idioms (a semitone or whole-tone scoop, a
  dive-bomb fall) without letting a payload ask for something unmusical. The shape
  is a word rather than `0 | 1` because a song file is read by people and agents
  ([song-authoring-dialect](song-authoring-dialect.md)), and `"bendShape": "fall"`
  needs no legend.

  **The defaults are `bend 0` and `bendShape 'scoop'`, and `bend 0` is a no-op** —
  every song, preset and demo that predates v5 is bit-identical, and the shape is
  inert until an amount is set ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)).
  Both fields join `SEQ_EXTRA_DEFAULTS`, so `PatternStore.restore` fills them under
  any legacy step, and the sparse encoder drops each one at its default, so a
  re-export of a pre-v5 file is byte-identical and **no `SongFile` version bump is
  needed** — the additive route REQ-a-step-carries-a-micro-offset took.

  **Seq only.** The fields live on `SeqStep`, not on `StepSettings`: the drum
  voices and the sampler's slots have no pitched voice to bend through the synth's
  detune, so a `TriggerCell` carrying them would be a value with no effect. The
  canonical validator range-checks the two keys only on a seq step (a trigger cell
  carrying them is tolerated like any other unknown key, never read, and dropped by
  the next export, which builds a trigger cell from its known fields), and the
  authoring dialect reads them only on a seq step object.

- **REQ-bend-shapes-are-scoop-and-fall** (v5) — **A scoop arrives; a fall leaves.**
  For a hit at `t` whose gate ends at `gateEnd`, the bend runs for
  `dur = BEND_FRACTION * (gateEnd - t)` (`BEND_FRACTION` = 0.5, in `step-hits.ts`),
  as a **linear ramp in cents** — linear in cents is exponential in Hz, which is
  how a bent string moves:
  - **scoop** — the pitch starts `bend` semitones away from the note and ramps to
    the note by `t + dur`. `bend -2` comes up from a whole tone below.
  - **fall** — the pitch starts on the note and ramps to `bend` semitones away by
    `t + dur`, then **holds there** until the voice is released. `bend +12` is an
    octave leap up; `bend -12` is a dive.

  A fraction of the *gate*, not of the step, so the bend always finishes inside the
  sounding part of the note: a staccato step gets a quick flick, a long one a slow
  bend. One constant rather than a per-step time: a third field is a third control
  in an already full row, and the gate already gives you the length.

- **REQ-a-bend-is-per-voice** (v5) — **The bend is played on a source that belongs to
  the voice, so it bends that note and nothing else.** Each `Voice` owns a
  `ConstantSourceNode` (`noteBend`, in cents) connected to `osc1`, `osc2` and `sub`
  detune — the same three params `master.pitchBend` reaches, so the two simply sum.
  Modulation stays in the graph ([ADR-017](../decisions/adr-017-modulation-in-graph.md)):
  nothing per frame, nothing per tick, only the events one note-on schedules.
  Every unison copy of the note bends identically; another track's chord tone on
  another voice does not move.

  The bend is carried to the voice in `NoteOptions.bend` (`{ semis, shape, dur }`), the
  same optional channel `pan` uses, so the arpeggiator, the keyboard and MIDI
  input — which never set it — are untouched.

  Cost: one `ConstantSourceNode` per voice, built once at boot like the voice's
  `velocitySource` and `keySource`, and idle at 0 between bent notes. It was not
  measured separately in the renderer's working set; it is the same node the
  voice already carries two of.

- **REQ-a-bend-zero-schedules-nothing** (v5) — **A voice schedules bend automation only
  when a bend is set or must be undone.** A voice remembers whether its bend
  source may be away from 0. A note with no bend on a clean voice writes **no
  event at all** — the default path stays bit-identical to pre-v5 and costs one
  branch. A note with no bend on a voice whose *previous* note bent does an
  anchored reset (`cancelScheduledValues(when)` + `setValueAtTime(0, when)`),
  so a stolen or reused voice never inherits a fall's held pitch. A bent note does
  the same anchored cancel, pins its start value at `when` and ramps; the anchor is
  the rule [architecture](../architecture.md) states and
  `tests/audio/no-unanchored-cancel.test.ts` enforces, since Gecko would otherwise
  start the ramp from the last *assigned* value rather than the curve's.

- **REQ-every-sub-hit-re-bends** (v5) — **A ratcheted step bends on every sub-hit,
  and a tie does not carry a bend across a step.** Each ratchet sub-hit is its own
  attack (`stepHits`), so each gets its own scoop or fall over its own
  sub-gate — a ratcheted fall is a stutter of falls. A tied step's fall holds its
  bent pitch only until the next step attacks: that step re-strikes the voice
  (REQ-gate-releases-or-cuts) with its **own** bend, and a next step at bend 0
  returns it to the written pitch at its attack. The step that sounds defines the
  pitch, which is the rule the rest of the sequencer already follows.

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
  MAX_EARLY_S = 0.06                                 # v3, REQ-an-early-offset-is-capped-in-seconds
  stepBend(s: {bend,bendShape}, hit): NoteBend | undefined   # v5 — undefined at bend 0
  BEND_FRACTION = 0.5                                # v5, REQ-bend-shapes-are-scoop-and-fall
note-output.ts:
  NoteOptions.bend?: NoteBend                           # v5 — { semis, shape, dur }
note-bend.ts:
  scheduleBend(param, bend: NoteBend | undefined, when, dirty): boolean
    # v5 — writes the scoop/fall events (anchored); returns the new "dirty" flag.
    # No bend on a clean param writes nothing (REQ-a-bend-zero-schedules-nothing)
limits.ts:
  BEND_MAX    = 12    # v5 — semitones either way (REQ-a-seq-step-carries-a-bend)
  MICRO_UNITS = 24    # notches per cell (1/384 note at the default rate)
  MICRO_MAX   = 12    # half a cell — the never-crosses bound (REQ-micro-range-is-half-a-cell)
drum-synths.ts:
  chokeRoute(ctx, output, chokeAt?): { dest, stopAt }  # downstream choke gain
```

### Data shapes

```yaml
StepSettings: { velocity, gate, prob, ratchet, tie, micro }
SeqStep:      StepSettings + { on, note, bend, bendShape }   # bend/bendShape v5
TriggerCell:  StepSettings + { on }       # DrumCell / SamplerStep
TRIGGER_CELL_DEFAULTS: { on:false, velocity:.., gate:1, prob:1, ratchet:1,
                         tie:false, micro:0 }
micro: integer, -MICRO_MAX..+MICRO_MAX, units of 1/MICRO_UNITS of a CELL
       (not of a 16th — a lane at 1/8 nudges in 1/24 of its own longer cell)
bend: integer, -BEND_MAX..+BEND_MAX semitones; 0 = no bend (default)
bendShape: 'scoop' | 'fall'; default 'scoop'; inert while bend is 0
NoteBend: { semis: number, shape: 'scoop' | 'fall', dur: seconds }
```

### Gesture inventory — the Bend controls (v5, seq panel only)

| Control | Gesture | Outcome | Precedent |
| --- | --- | --- | --- |
| Bend slider | − / + button | −1 / +1 semitone | the Micro stepper beside it |
| Bend slider | drag on the track | sweep, snapped to whole semitones | Micro |
| Bend slider | left / right arrow (focused) | −1 / +1 semitone | Micro |
| Bend slider | double-click | back to 0 (no bend) | Micro; the knobs |
| Scoop / Fall | click a button | that shape is the step's shape | the Ratchet 1–4 group: one lit of a set |
| either | wheel, long-press | — (not taken, as for Micro) | — |

The Bend slider *is* the Micro slider's factory (`makeSlider` with `center`,
`stepper`, `snap`, `keyStep`, `resetTo`), so its drag lifecycle, arrow-key
isolation and testid minting are inherited, not re-typed. The shape is two labelled
buttons rather than one toggle: a toggle reads as on/off, and "fall" is not "scoop
off". They are words, not arrows, so no glyph is involved
([iconography](iconography.md)). The pair is dimmed while `bend` is 0 — the shape
still edits, since setting a shape first and an amount second is a legitimate
order, but the dimming says it is not yet audible.

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
only `isEditableTarget`, so an unstopped Shift+arrow would *also* move the playhead
a bar ([transport-position](transport-position.md) REQ-home-and-shift-arrows-seek) — one
gesture, two outcomes, which [ADR-014](../decisions/adr-014-dont-make-me-think.md)
law 2 forbids. (Until [input-control](input-control.md) v17 a *bare* arrow shifted
the playable keyboard's octave too; that moved to `-` / `=`.) Stopping propagation
at the element keeps the rule local to the control that owns the keys — the same
one every focused knob now follows ([knob-keyboard-access](knob-keyboard-access.md)).
`Home` is deliberately left alone — it is the transport's seek-to-top
([transport-position](transport-position.md)).

### Layer touchpoints

```yaml
consumers: sequencer.ts, drum-machine.ts, sampler-machine.ts all import step-hits
  sequencer.ts applies microOffset ITSELF (REQ-micro-is-one-pure-offset); drum + sampler inherit it from
  forEachActiveHit, so neither machine file changes for micro
ui: src/ui/components/step-settings.ts (StepSettingsEditor) — shared edit row;
    each panel owns its own selection cursor. Step buttons visualise settings via
    StepButton.setViz() (gate width, velocity brightness, ratchet ticks, tie/prob,
    and micro as a horizontal shift of the fill layer — the hit visibly sits left
    or right in its cell)
    makeSlider grows { center, snap, format } rather than a second slider
    implementation, so REQ-edit-sliders-are-gesture-scoped's drag discipline is inherited, not re-typed
bend (v5): sequencer.ts computes stepBend(s, h) per sub-hit and passes it in
    NoteOptions → Polyphony → Voice.noteOn → scheduleBend on voice.noteBend.offset.
    The StepSettingsEditor takes an optional `bend` get/set pair; only the seq
    panel passes it, so the drum and sampler rows are unchanged. StepButton.setViz
    takes an optional bend direction and draws a small rising/falling stroke in
    the cell's lower corner (::before; ::after is the ratchet ticks)
testids: seq-bend plus -track / -dec / -inc / -value (v5, minted by makeSlider);
    seq-bend-scoop, seq-bend-fall.
    <seq|drum|sampler>-micro plus -micro-track / -dec / -inc / -value.
    Minted at the factory (makeSlider's `testid` option), because a positional
    selector into the row breaks the moment it grows a button — which it did.
migration: PatternStore.restore spreads TRIGGER_CELL_DEFAULTS UNDER incoming cells
    so legacy {on, velocity} cells gain the new fields (see song-mode.md).
    micro needs no other migration step and no format bump (REQ-a-step-carries-a-micro-offset)
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

Scenario: micro 0 changes nothing at all (v3, REQ-a-step-carries-a-micro-offset, regression)
  Given a step with micro 0
  Then microOffset returns exactly 0
  And its hit times are identical to those computed before micro existed
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: A step sounds early or late by 1/24 of its own cell (v3, REQ-a-step-carries-a-micro-offset)
  Given a cell of duration d
  When micro is +6
  Then the hit lands at when + d/4
  And with micro -6 it lands at when - d/4
  And a lane whose cell is twice as long moves twice as far in seconds
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: Nudged neighbours can meet but never cross (v3, REQ-micro-range-is-half-a-cell, the invariant)
  Given step n at micro +12 and step n+1 at micro -12 at 125 BPM
  Then both land on the same instant
  And no pair of micro values within the range produces a later step sounding first
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: An early nudge is capped, a late one is not (v3, REQ-an-early-offset-is-capped-in-seconds, edge)
  Given a very slow tempo where half a cell exceeds MAX_EARLY_S
  When micro is -12
  Then the offset saturates at -MAX_EARLY_S rather than scheduling into the past
  And micro +12 at the same tempo is a full half-cell, uncapped
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: A nudged seq step releases the previous note at the nudged time (v3, REQ-micro-is-one-pure-offset)
  Given a monophonic seq track whose step is on with micro -12
  When that step fires
  Then the previous note's release is scheduled at the nudged attack time
  And not at the un-nudged grid time, which would cut the new note
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: The playhead does not follow the nudge (v3, REQ-micro-is-one-pure-offset, edge)
  Given a drum step with micro +12
  When its tick fires
  Then the step listener reports the cell on the grid, un-offset
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A legacy song has no micro and loads at 0 (v3, REQ-a-step-carries-a-micro-offset, regression)
  Given a song file whose step cells carry no micro key
  When it is restored
  Then every step has micro 0 and sounds exactly as it did before v3
  And re-exporting it emits no micro key at all
# pinned by: tests/state/patterns.test.ts, tests/state/song.test.ts

Scenario: The Micro slider takes arrow keys without reaching the global shortcuts (v3, REQ-an-early-offset-is-capped-in-seconds)
  Given the Micro slider has focus and the step's micro is 0
  When the right arrow key is pressed
  Then micro becomes +1
  And the event does not reach the global shortcut handler on window
  And a double-click on the track returns it to 0
# pinned by: tests/ui/step-settings.test.ts

Scenario: bend 0 schedules nothing (v5, REQ-a-bend-zero-schedules-nothing, regression)
  Given a seq step with bend 0
  Then stepBend returns undefined
  And scheduleBend on a clean param writes no automation event at all
# pinned by: tests/audio/transport/step-hits.test.ts, tests/audio/note-bend.test.ts

Scenario: A scoop arrives at the note (v5, REQ-bend-shapes-are-scoop-and-fall)
  Given a hit at t with gate end t + 0.2 and a step with bend -2, shape scoop
  Then the bend's duration is 0.1 (BEND_FRACTION of the gate)
  And the bend param is pinned at -200 cents at t and ramps linearly to 0 by t + 0.1
# pinned by: tests/audio/transport/step-hits.test.ts, tests/audio/note-bend.test.ts

Scenario: A fall leaves the note and holds (v5, REQ-bend-shapes-are-scoop-and-fall)
  Given a step with bend +12, shape fall
  Then the bend param is pinned at 0 at t and ramps to +1200 cents by t + dur
  And no later event returns it to 0 before the next note-on
# pinned by: tests/audio/note-bend.test.ts

Scenario: A reused voice does not inherit a fall (v5, REQ-a-bend-zero-schedules-nothing, edge)
  Given a voice whose last note fell +12
  When it plays a note with no bend
  Then the bend param is cancelled from the new attack and pinned at 0 there
  And a further unbent note writes nothing
# pinned by: tests/audio/note-bend.test.ts

Scenario: The sequencer bends each sub-hit and only the bent step (v5, REQ-every-sub-hit-re-bends, REQ-a-bend-is-per-voice)
  Given a seq step with bend -1, shape scoop, ratchet 2
  When it fires
  Then both playNote calls carry a bend whose dur is BEND_FRACTION of that sub-hit's gate
  And a neighbouring step with bend 0 is played with no bend at all
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A legacy song has no bend and re-exports byte-identical (v5, REQ-a-seq-step-carries-a-bend, regression)
  Given a song file whose seq steps carry no bend or bendShape key
  When it is restored
  Then every seq step has bend 0 and bendShape 'scoop'
  And re-exporting it emits neither key
  And a step with bend -3, shape fall round-trips exactly
# pinned by: tests/state/song.test.ts

Scenario: An out-of-range bend is refused, and coerced in the dialect (v5, REQ-a-seq-step-carries-a-bend, edge)
  Given a canonical seq step with bend 13, or 1.5, or bendShape 'wobble'
  Then the canonical validator refuses the file
  And the authoring dialect reports the field and imports the rest of the song
# pinned by: tests/state/song-validate.test.ts, tests/state/song-author.test.ts

Scenario: The Bend controls edit the selected seq step (v5, gesture inventory)
  Given the seq edit row with a step selected
  When + is pressed twice on the Bend slider and Fall is clicked
  Then the step has bend 2 and bendShape 'fall'
  And the drum and sampler edit rows have no Bend controls
# pinned by: tests/ui/step-settings.test.ts
```

## Tests & verification

- `tests/audio/transport/step-hits.test.ts` (pure — including the REQ-micro-range-is-half-a-cell ordering
  invariant and the REQ-an-early-offset-is-capped-in-seconds cap), `tests/audio/transport/sequencer.test.ts` (the
  nudged release), `tests/audio/transport/drum-machine.test.ts` (playhead not
  offset), `tests/state/patterns.test.ts` + `tests/state/song.test.ts` (default,
  migration, sparse round-trip), `tests/ui/step-settings.test.ts`
  (edit row + drag lifecycle + arrow-key isolation), `tests/ui/step-button.test.ts`
  (viz), `e2e/patterns.spec.ts` (grid + viz + clock advance).
- v5: `tests/audio/note-bend.test.ts` (the scheduled events, against a recording
  param — the mock `AudioParam` keeps no event list), `step-hits.test.ts`
  (`stepBend`), `sequencer.test.ts` (bend in `NoteOptions`, per sub-hit),
  `song.test.ts` / `song-validate.test.ts` / `song-author.test.ts` (default,
  sparse round-trip, refuse vs coerce), `step-settings.test.ts` (the Bend row).
- `npm test` / `npm run e2e` / `npm run typecheck`.
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)): nothing automated can
  tell you whether a nudge *feels* right. Mute every lane but kick and snare, run a
  straight two-bar pattern, and A/B the snare at `0`, `+3` and `-3`; `±12` should be
  obviously, deliberately drunk.
- **Bend by ear** (v5): a mono seq line, one step at scoop `-2`, one at fall `+12`,
  A/B against the same pattern at bend 0, through `npm run bench:audio` **and**
  `--browser firefox` — this is `AudioParam` automation, the class Gecko and Blink
  disagree on. A scoop should read as a sung slide into the note, not a detuned
  attack; a fall should finish before the gate closes.

## Open questions / future

- New per-step fields for every machine go in `StepSettings` +
  `TRIGGER_CELL_DEFAULTS`; a seq-only field goes in `SeqStep` +
  `SEQ_EXTRA_DEFAULTS`, as bend did (v5). Either way the defaults-spread-under
  migration keeps old songs valid.
- **[render-to-sampler](render-to-sampler.md) crops on the unswung grid**, so a
  micro-timed *first* or *last* cell of the rendered bar can fall outside the crop
  (an early first hit lands before the crop start, a late last hit after its end).
  Same class as the swing note already in `bankCropRange`, and left alone for the
  same reason: the bar length must stay exact.
- **The first step after `start()`** carries only 50 ms of lead
  (`nextStepTime = ctx.currentTime + 0.05`), which is less than `MAX_EARLY_S`, so a
  deep early nudge on it clamps to on-time. It is the step under the Play press;
  not worth re-origining the grid for. ~~The same 50 ms hole reopens on every
  dropout re-origin.~~ Closed by [transport](transport.md) v11: a dropout
  re-origins with `DROPOUT_LEAD_S` (0.1 s), past `MAX_EARLY_S`.

  "Clamps to on-time" was true of the **envelope** and false of the **choke**,
  which kept the unclamped time and so cut a short-gated hit mid-attack or
  dropped it outright. Fixed in [drum-machine](drum-machine.md) REQ-a-clamped-hit-carries-its-choke and
  [sampler](sampler.md) REQ-a-slot-starts-from-zero: the choke shifts with the start, so the gate
  keeps its length. The clamp is still a bunching device, not a repair — it is
  `MAX_EARLY_S` that keeps hits out of the past in the first place.
- **Bend, not built yet** (v5): a per-step bend *time* rather than the fixed
  `BEND_FRACTION`; a drawn multi-point pitch curve (the Ableton/Bitwig model);
  sampler bend through `playbackRate`/detune; bend as a bank-level default in the
  authoring dialect's cascade (today it is read on a seq step object only).
- A **per-lane** shift (a DAW-style track delay, "the whole snare sits behind the
  beat") is the natural neighbour and would reuse `microOffset` wholesale. Not
  built: nudging the lane's steps covers it, and a second control needs its own
  storage and UI.
