# Voicing, unison, glide & drift (voice management)

```yaml
id: voicing
status: implemented
version: 3   # v3: Polyphony owns glide time (setGlideTime) + exposes pitchHz
owner: core
related:
  - architecture
  - oscillators
  - zoetrope   # the only consumer of pitchHz
source:
  - src/audio/polyphony.ts     # voice pool, alloc, unison, glide, drift (ADR-008)
  - src/audio/engine.ts        # builds voices; thin playNote/releaseNote delegators
  - src/audio/voice.ts
  - src/state/params.ts
  - src/ui/app.ts
```

How notes become voices: poly vs mono, unison stacking, glide between notes,
analogue drift, pitch bend, and keyboard transpose. These are the engine-level
"how it plays" controls, distinct from per-voice tone ([oscillators](oscillators.md)).

## Background / Why

A real analogue synth's character is as much about *voice allocation* as about the
oscillators: mono with glide for basslines and leads, poly for chords, unison for
a fat detuned stack, and subtle per-voice pitch **drift** for an un-digital,
"alive" quality. `glide.mode` defaults to `always` (1) because `always` with glide
time 0 reproduces the pre-song-mode behaviour, keeping existing presets unchanged.

## Requirements

- **REQ-1** — `voicing.mode` toggles mono/poly; switching **kills all voices** so
  no notes hang across the mode change.
- **REQ-2** — Unison stacks `1..4` detuned copies per note (`unison.detune` cents).
- **REQ-3** — Glide time + mode control portamento; defaults reproduce the legacy
  no-glide behaviour. `Polyphony` owns both (v3): `setGlideTime` fans the seconds
  out to the voices *and* keeps the number, because `pitchHz` (REQ-6) has to ramp
  on the same curve the oscillators do.
- **REQ-6** — (v3) `Polyphony.pitchHz` is a `ConstantSourceNode` carrying the
  frequency of the most recent note-on, written in `playNote` with the same
  `when` and ramp shape as `Osc.setFrequency`. It is a control signal, not a
  param: nothing renders it unless a consumer connects to it, so it is a no-op
  addition for anything that doesn't.
- **REQ-4** — Analogue drift adds subtle per-voice pitch wander (default 0 = off).
  The 110 ms drift interval runs **only while drift > 0** (v2): `setDrift`
  starts it on a 0→>0 transition and on >0→0 clears it after settling the
  detune source back to 0 — at the default there is no recurring main-thread
  timer (pinned by `tests/audio/polyphony.test.ts`).
- **REQ-5** — Pitch bend (`±` cents) and keyboard transpose (`±2` oct) shift pitch
  globally.
- **REQ-6** — Note events flow `bus.onNote → Engine.playNote / releaseNote` unless
  `passthroughSuppressed` (arp/sequencer own triggering then).
- **REQ-7** — (v2) The voice lifecycle drives the ladder filter's **idle gating**:
  voices boot inactive, `noteOn` activates the filter unconditionally, and
  release-completion / `kill` deactivate it — see
  [ladder-filter](ladder-filter.md) REQ-10 for the protocol and its safety
  asymmetry (pinned by `tests/audio/voice.test.ts`).

## Technical design

### Data shapes (registry)

```yaml
voicing.mode:      { discrete, labels: VOICING_LABELS, range: 0..1, default: 1 }
unison.voices:     { discrete, labels: UNISON_LABELS, range: 1..4, default: 1 }   # no-op default
unison.detune:     { range: 0..50, default: 12, unit: cents }
mixer.glide:       { range: 0..1, default: 0, format: ms }
glide.mode:        { discrete, labels: GLIDE_MODE_LABELS, range: 0..2, default: 1 }  # 'always'
analog.drift:      { range: 0..1, default: 0 }                                       # no-op default
master.pitchBend:  { range: -1..1, default: 0, unit: semitones }
keyboard.transpose:{ discrete, range: -2..2, default: 0 }
```

### Layer touchpoints

```yaml
engine (subscribeParams) -> Polyphony setters (poly/unison/glide/drift live there):
  voicing.mode  -> polyphony.setPoly(v >= 0.5)        # kills all voices on change
  unison.voices -> polyphony.setUnisonCount(x)        # max(1, round(x))
  unison.detune -> polyphony.setUnisonDetune(x)
  mixer.glide   -> polyphony.setGlideTime(x)           # v3: fans out to the voices there
  glide.mode    -> polyphony.setGlideMode(x)
  analog.drift  -> polyphony.setDrift(x)               # drift source owned by Polyphony
  master.pitchBend -> rampTo(this.pitchBend.offset, x * PITCH_BEND_RANGE_CENTS, FAST)
note flow: bus.onNote -> Engine.playNote/ releaseNote -> Polyphony (unless passthroughSuppressed)
pitchHz (v3): a ConstantSourceNode on Polyphony carrying the latest note's Hz,
  written in playNote with the same when + glide ramp as Osc.setFrequency. Inert
  unless something connects to it (zoetrope.md REQ-3 is the only consumer today).
ui: src/ui/app.ts (VOICE / UNISON / GLIDE controls; pitch-bend + transpose)
```

## Scenarios (BDD)

```gherkin
Scenario: Switching mono<->poly never leaves a hanging note
  Given a note is sounding
  When the user toggles voicing.mode
  Then all voices are killed and no note hangs
# pinned by: tests/state/params.test.ts (subscription); manual/e2e controls

Scenario: Glide defaults reproduce legacy behaviour (backward compat, edge)
  Given glide.mode is 'always' (1) and mixer.glide is 0
  Then notes retrigger with no audible portamento, exactly as before song mode
# pinned by: tests/state/preset.test.ts (existing presets unchanged)
```

## Tests & verification

- `tests/state/params.test.ts`, `tests/state/preset.test.ts`, `e2e/controls.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- New voice params must keep **no-op defaults** (see
  [add-a-parameter](../recipes/add-a-parameter.md)) to preserve old presets.
