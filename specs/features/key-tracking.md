# Filter key tracking

```yaml
id: key-tracking
status: implemented
version: 1
owner: core
related:
  - ladder-filter
  - filter-models
  - envelopes
  - lfo
  - ../decisions/adr-005-cutoff-as-midi-note
  - ../decisions/adr-006-no-op-param-defaults
source:
  - src/state/params.ts       # filter.keytrack ParamDef
  - src/audio/voice.ts        # the keytracked cutoff recompute
  - src/audio/engine.ts       # subscribeParams fan-out
  - src/ui/app.ts             # the KEYTRK knob
```

The fourth modulator into filter cutoff, alongside the [filter
envelope](envelopes.md) and the [LFO](lfo.md): the played note itself. Applies to
**both** filter models ([filter-models.md](filter-models.md)).

## Background / Why

Without key tracking a patch is only in tune with itself at one point on the
keyboard: play two octaves up and the same cutoff now sits *below* the
fundamental, so the note goes dull and thin. Key tracking scales cutoff with the
note so timbre stays consistent across the keyboard — and at high resonance it
makes a self-oscillating filter **playable as a pitched voice**.

[ADR-005](../decisions/adr-005-cutoff-as-midi-note.md) named key tracking as one
of the motivations for representing cutoff as a MIDI note number in the first
place ("a contributor adding a new cutoff modulator must emit a semitone offset"),
but it was never built. Because cutoff is already in note units, the whole
feature is one addition in semitone space.

## Requirements

- **REQ-1** — `filter.keytrack` is a scalar `[0, 1]`, **default `0`** — a no-op,
  so every existing preset is unchanged ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)).
  `1` means one semitone of cutoff per semitone of note (100% tracking).
- **REQ-2** — The offset is `keytrack * (note - KEY_CENTER)` semitones with
  `KEY_CENTER = 60`, added to the voice's base cutoff. At `note === KEY_CENTER`
  the offset is zero at **any** keytrack amount, so turning the knob never moves
  the sound of a patch played at centre.
- **REQ-3** — It stays in **semitone space** and is applied to the *base value*
  of `cutoffNote`, never converted to Hz (ADR-005). The envelope and LFO keep
  summing into the same `AudioParam` as additive inputs, so all four modulators
  compose.
- **REQ-4** — The keytracked value is applied **instantly at `noteOn`**
  (`setValueAtTime` at the note's start time), not ramped: a glide from the
  previous note's cutoff would whoop. A change to `filter.cutoff` or
  `filter.keytrack` while a note is held **ramps** (`rampTo`, `RAMP_FAST`) like
  any knob drag.
- **REQ-5** — The result is clamped to the worklet's `cutoffNote` range, so an
  extreme note × full tracking cannot push the coefficient past Nyquist. (The
  worklet clamps internally too; this keeps the reported value honest.)
- **REQ-6** — Changing `filter.keytrack` updates every voice in the pool live
  (8, or 5 on the `weak` tier — [performance-mode](performance-mode.md)), and a voice
  holding a note recomputes immediately rather than waiting for the next note.

## Technical design

### Contract / public interface

```yaml
Voice:  # src/audio/voice.ts
  setFilterCutoff(note)          # stores the base, then re-applies (REQ-6)
  setFilterKeytrack(amount)      # stores the amount, then re-applies (REQ-6)
  # internal: the cached base cutoff, the cached amount and the held note number
  #           are the only state; the effective value is derived, never stored.
```

### Data shapes (registry)

```yaml
filter.keytrack: { range: 0..1, default: 0, format: fmtPct }
KEY_CENTER: 60   # the note at which tracking contributes nothing (REQ-2)
```

### Layer touchpoints & ordering

```yaml
1_registry:  src/state/params.ts  -> registerDefaults()
2_engine:    src/audio/engine.ts  -> subscribeParams()
   filter.keytrack -> all((v, x) => v.setFilterKeytrack(x))
3_ui:        src/ui/app.ts        -> FILTER panel, KEYTRK knob
```

The effective base cutoff is derived in one place in `Voice` from three cached
scalars, so `noteOn`, a cutoff knob drag and a keytrack knob drag all funnel
through the same expression and cannot drift apart.

### Persistence

Nothing new — `filter.keytrack` is a patch param by prefix, snapshotted and
restored with the rest (ADR-006 covers files that predate it).

## Visual aids

```
cutoff 90, keytrack 0.5           effective cutoff
  note 48 (an octave below centre)  90 + 0.5*(48-60) = 84
  note 60 (centre)                  90
  note 72 (an octave above centre)  90 + 0.5*(72-60) = 96
```

## Scenarios (BDD)

```gherkin
Scenario: Key tracking raises cutoff with the note
  Given filter.cutoff is 90 and filter.keytrack is 0.5
  When a note 12 semitones above centre is triggered
  Then the voice's cutoffNote base is set to 96 at the note's start time
# pinned by: tests/audio/voice.test.ts

Scenario: The default is a no-op (backward compat)
  Given filter.keytrack is 0
  When any note is triggered
  Then the voice's cutoffNote base equals filter.cutoff exactly
# pinned by: tests/audio/voice.test.ts

Scenario: Centre note is unaffected at any amount (edge)
  Given filter.cutoff is 90
  When keytrack sweeps 0 -> 1 while note 60 sounds
  Then the cutoffNote base stays 90 throughout
# pinned by: tests/audio/voice.test.ts

Scenario: Turning the knob under a held note recomputes immediately
  Given a note is sounding and filter.keytrack is 0
  When the user drags KEYTRK to 1
  Then the held voice ramps to the keytracked value without a re-trigger
# pinned by: tests/audio/voice.test.ts

Scenario: An extreme note cannot exceed the cutoff range (edge)
  Given filter.cutoff is 130 and filter.keytrack is 1
  When the highest playable note is triggered
  Then the applied cutoffNote is clamped to the WORKLET's range (CUTOFF_MIN 0 ..
       CUTOFF_MAX 135), not to filter.cutoff's registered max of 130 — REQ-5
# pinned by: tests/audio/voice.test.ts
```

## Tests & verification

- Unit: `tests/audio/voice.test.ts` — the offset, the no-op default, the centre
  note, the live recompute, the clamp. `npm test`.
- Unit: `tests/state/params.test.ts` — registration and clamping.
- Typecheck: `npm run typecheck`.

## Open questions / future

- **Negative tracking.** A bipolar `[-1, 1]` range (cutoff *falls* as you play
  up) is a real, if rare, sound-design tool. Left out to keep the knob legible;
  widening the range later is backward-compatible because 0 stays the default.
- **Velocity → cutoff** was the other modulator ADR-005 anticipated, and it has
  since been built: `filter.velAmount` scales `filEnv.trigger`'s peak
  (`Voice.noteOn`) — see [envelopes](envelopes.md) REQ-5.
