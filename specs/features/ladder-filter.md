# Ladder filter

```yaml
id: ladder-filter
status: implemented
version: 1
owner: core
related:
  - architecture
  - envelopes
  - lfo
  - ../recipes/add-a-parameter
source:
  - public/worklets/ladder-filter.js     # the DSP (audio thread, plain JS)
  - src/audio/ladder-filter/node.ts       # LadderFilterNode wrapper
  - src/state/params.ts                   # filter.* ParamDefs
  - src/audio/engine.ts                   # subscribeParams (per-voice)
  - src/ui/app.ts                         # the FILTER panel
```

The resonant low-pass ladder filter — the synth's main tone shaper. It is also the
**canonical worked example** of the repo's universal scalar-parameter pattern
(`filter.cutoff` is the smallest, clearest case), referenced by the
[add-a-parameter recipe](../recipes/add-a-parameter.md).

## Background / Why

A Moog-style 4-pole ladder gives the synth its character: a self-resonant low-pass
with drive. It runs as an **AudioWorklet** (`public/worklets/ladder-filter.js`,
plain JS on the audio thread) so it can do per-sample non-linear processing.

The load-bearing convention: **cutoff is a MIDI note number, not Hz.** The worklet
takes `cutoffNote`, so the [filter envelope](envelopes.md) and [LFO](lfo.md) can sum
into the cutoff **additively in semitones** via Web Audio's native `AudioParam`
input summation — musical modulation that stacks cleanly, rather than multiplying
frequencies. The on-screen value is still shown in Hz for the user.

## Requirements

- **REQ-1** — Four filter params: `cutoff` (note units), `resonance`, `drive`,
  `envAmount` (bipolar semitone depth).
- **REQ-2** — `cutoff` range `[30, 130]` note, default `90`; displayed in Hz but
  stored as a note number.
- **REQ-3** — Changing any filter param updates **all 8 voices** live.
- **REQ-4** — Modulation (filter envelope, LFO) is **additive in semitone space**;
  cutoff must not be re-expressed in Hz anywhere in the audio path.
- **REQ-5** — `LadderFilterNode.loadModule()` is awaited (in `Engine.init()`)
  before any voice is created.

## Technical design

### Contract / public interface

The filter params are plain `ParamBus` parameters — readers/writers use the
standard bus surface (`bus.set`/`get`/`subscribe`). The worklet wrapper:

```yaml
LadderFilterNode:  # src/audio/ladder-filter/node.ts
  static loadModule(ctx): Promise<void>   # await once per context, before voices
  cutoffNote: AudioParam                  # note units; env + LFO sum in here
  # (+ resonance / drive params per the node's surface)
Voice setters (per-voice, called by the engine):
  setFilterCutoff(note) / setFilterResonance(r) / setFilterDrive(d) / setFilterEnvAmount(semis)
```

### Data shapes (registry)

```yaml
filter.cutoff:    { range: 30..130, default: 90, format: fmtNoteFromCutoff }  # NOTE units
filter.resonance: { range: 0..4.2,  default: 0.5 }
filter.drive:     { range: 0.5..6,  default: 1.2, format: "x" }
filter.envAmount: { range: -48..48, default: 24, unit: semitones }            # bipolar
```

### Layer touchpoints (the universal 3-layer scalar pattern)

```yaml
1_registry:  src/state/params.ts  -> registerDefaults()   # the filter.* ParamDefs
2_engine:    src/audio/engine.ts  -> subscribeParams()
   filter.cutoff    -> all((v, x) => v.setFilterCutoff(x))      # all() fans to 8 voices
   filter.resonance -> all((v, x) => v.setFilterResonance(x))
   filter.drive     -> all((v, x) => v.setFilterDrive(x))
   filter.envAmount -> all((v, x) => v.setFilterEnvAmount(x))   # semitone depth
3_ui:        src/ui/app.ts  -> FILTER panel (CUTOFF / RESO / DRIVE / ENV knobs)
init order:  Engine.init() awaits LadderFilterNode.loadModule() before creating voices
```

### The note-vs-Hz invariant

`setFilterCutoff` passes the note straight to the worklet's `cutoffNote`
`AudioParam`. The filter envelope and LFO are wired as **additive inputs** to that
same param (in semitones), scaled by `filter.envAmount`. Never convert cutoff to Hz
inside the audio path — only the `format` function does, and only for the label.
This is a shared invariant with [envelopes](envelopes.md) and [lfo](lfo.md).

## Visual aids

```
CUTOFF knob ──bus.set('filter.cutoff', note)──► ParamBus
ParamBus ──subscribe──► Engine.subscribeParams ──► each Voice.setFilterCutoff(note)
                                                         │
                            filterEnv (semitones) ──────►├─ ladder worklet cutoffNote
                            LFO (semitones) ────────────►┘   (additive AudioParam sum)
```

## Scenarios (BDD)

```gherkin
Scenario: Knob drag updates the live cutoff
  Given the audio engine is running
  When the user drags the CUTOFF knob to note 100
  Then bus.get('filter.cutoff') returns 100
  And every voice's ladder filter cutoffNote tracks 100
# pinned by: tests/state/params.test.ts, e2e/controls.spec.ts

Scenario: Out-of-range writes are clamped
  When code calls bus.set('filter.cutoff', 200)
  Then bus.get('filter.cutoff') returns 130   # clamped to max
# pinned by: tests/state/params.test.ts

Scenario: Value is shown in Hz but stored as a note (edge)
  Given filter.cutoff is 90
  Then the knob label reads a Hz string via fmtNoteFromCutoff
  And the stored value remains the note number 90, not a frequency
# pinned by: tests/state/params.test.ts (def/format)

Scenario: Filter envelope sweeps cutoff additively (edge)
  Given filter.cutoff is 60 and filter.envAmount is 24
  When a note triggers
  Then the effective cutoff peaks ~24 semitones above 60, summed at the AudioParam
# pinned by: envelopes.md invariant; tests/state/params.test.ts
```

## Tests & verification

- Unit: `tests/state/params.test.ts` — registration, clamping, subscribe,
  snapshot/restore. `npm test`.
- E2E: `e2e/controls.spec.ts` — drives the control surface; assert via
  `window.__synth.bus.get('filter.cutoff')`. `npm run e2e`.
- Typecheck: `npm run typecheck`.

## Open questions / future

- This spec doubles as the reference instance for the
  [add-a-parameter recipe](../recipes/add-a-parameter.md): `filter.cutoff` is the
  textbook scalar param.
