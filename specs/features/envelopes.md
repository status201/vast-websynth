# Envelopes (amp + filter ADSR)

```yaml
id: envelopes
status: implemented
version: 1
owner: core
related:
  - architecture
  - ladder-filter
source:
  - src/audio/envelope.ts
  - src/audio/voice.ts
  - src/state/params.ts
  - src/audio/engine.ts
  - src/ui/app.ts
```

Two per-voice ADSR envelopes: one shapes amplitude, one modulates the filter
cutoff. The filter envelope is the key reason cutoff is stored in **semitones**
(see [ladder-filter](ladder-filter.md)).

## Background / Why

Amplitude ADSR gives every note its shape (pluck vs pad). The filter envelope
sweeps the cutoff over time for the characteristic subtractive "wow" — and because
it sums **additively in semitone space** onto the cutoff `AudioParam`, its depth
(`filter.envAmount`, in semitones, bipolar) is musical and stacks cleanly with the
LFO.

## Requirements

- **REQ-1** — Amp envelope (`env.amp.*`) drives per-voice gain; release frees the
  voice.
- **REQ-2** — Filter envelope (`env.fil.*`) modulates cutoff additively in
  semitones, scaled by `filter.envAmount` (`-48..48`, bipolar).
- **REQ-3** — Both apply per-voice (each `Voice` owns its `ampEnv` / `filEnv`).

## Technical design

### Data shapes (registry)

```yaml
env.amp.attack:  { range: 0.001..4, default: 0.005, format: ms }
env.amp.decay:   { range: 0.001..4, default: 0.2,   format: ms }
env.amp.sustain: { range: 0..1,     default: 0.8 }
env.amp.release: { range: 0.001..6, default: 0.4,   format: ms }
env.fil.attack:  { range: 0.001..4, default: 0.005, format: ms }
env.fil.decay:   { range: 0.001..4, default: 0.6,   format: ms }
env.fil.sustain: { range: 0..1,     default: 0.2 }
env.fil.release: { range: 0.001..6, default: 0.4,   format: ms }
filter.envAmount:{ range: -48..48,  default: 24, unit: semitones }   # filter spec
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  env.amp.* -> all((v, x) => v.ampEnv.setAttack/ setDecay/ setSustain/ setRelease)
  env.fil.* -> all((v, x) => v.filEnv.<same>)
  filter.envAmount -> all((v, x) => v.setFilterEnvAmount(x))   # semitone depth
ui: src/ui/app.ts (AMP ENV / FILTER ENV panels)
```

## Scenarios (BDD)

```gherkin
Scenario: A long release lets notes ring out
  Given env.amp.release is 2.0
  When a key is released
  Then the voice fades over ~2 s before freeing
# pinned by: tests/state/params.test.ts, e2e/controls.spec.ts

Scenario: Filter envelope sweeps the cutoff additively (edge)
  Given filter.cutoff is 60 and filter.envAmount is 24
  When a note triggers
  Then the effective cutoff peaks ~24 semitones above 60, summed at the AudioParam
# pinned by: ladder-filter.md invariant; tests/state/params.test.ts
```

## Tests & verification

- `tests/state/params.test.ts`, `e2e/controls.spec.ts`.
- `npm test` / `npm run e2e` / `npm run typecheck`.

## Open questions / future

- Keep filter-env modulation in semitones — never re-express cutoff in Hz in the
  audio path (shared invariant with [ladder-filter](ladder-filter.md) and
  [lfo](lfo.md)).
