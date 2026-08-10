# Envelopes (amp + filter ADSR)

```yaml
id: envelopes
status: implemented
version: 3   # v3: REQ-5 — the filter envelope can follow velocity
             #     (`filter.velAmount`, default 0 = the v2 behaviour exactly)
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
- **REQ-4** — Scheduling is **future-time-safe**: `trigger`/`release_` may be
  called with an audio time up to the transport look-ahead (0.1–0.2 s) in the
  future (sequencer/arpeggiator schedule a step's attack *and* its `gateEnd`
  release on the same tick). The phase change anchors at the value the curve
  *reaches at that time* — never the live `AudioParam.value`, which is a stale
  snapshot of *now* and steps the output discontinuously (an audible click).
  The envelope is the **sole writer** of its gain param; `Voice.kill` cuts
  through `Envelope.cutFast`, never by scheduling on the param directly.

- **REQ-5 — The filter envelope can follow velocity (v3).** `Voice.noteOn`
  triggered the amp envelope at the note's velocity and the filter envelope at a
  hard-coded `1`, so **playing harder got louder and never brighter** — the single
  most-expected behaviour of a subtractive synth, and the one it did not have.

  A new `filter.velAmount` (`0..1`, **default 0**) sets how much of the filter
  envelope's depth velocity controls, applied as the envelope's peak:

  ```
  peak = 1 - velAmount + velAmount * velocity     // lerp(1, velocity, velAmount)
  ```

  At `0` the peak is exactly `1` — bit-identical to v2, which is what
  [ADR-006](../decisions/adr-006-no-op-param-defaults.md) requires of a new param:
  every existing preset, song and demo must sound unchanged. At `1` the sweep
  scales straight with velocity. Because `filEnv` feeds `filEnvScale` (the
  `envAmount` semitone gain) and *that* sums onto `cutoffNote`, scaling the peak
  scales the **sweep depth** in semitones — it does not move the base cutoff, so a
  soft note is duller, never detuned or quieter than its amp envelope says.

  It applies to **every** note source — keyboard, MIDI, the sequencer's per-step
  velocity and the arpeggiator's fixed 0.85 — because it lives in `Voice.noteOn`,
  the one place a velocity is already in hand.

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
filter.velAmount:{ range: 0..1,     default: 0 }   # v3, REQ-5 — 0 = velocity does
                                                   #   not touch the filter (ADR-006)
```

### Scheduled-automation model (REQ-4)

`Envelope` tracks every event it schedules (anchors `{time, value}` +
`setTargetAtTime` segments `{time, target, tau}`) and computes `valueAt(t)`
analytically — exact, since it only ever uses `setTargetAtTime` exponentials
(`v = target + (v0 − target)·e^−(t−t0)/τ`, each segment truncated by the next
event). Each phase change drops the tracked tail from `t` (mirroring
`cancelScheduledValues(t)`) and pins the computed value with
`setValueAtTime(valueAt(t), t)`. `cancelAndHoldAtTime` would do this natively
but is missing in Firefox (and in the test mocks), so the model is used
everywhere.

### Layer touchpoints

```yaml
engine (subscribeParams):
  env.amp.* -> all((v, x) => v.ampEnv.setAttack/ setDecay/ setSustain/ setRelease)
  env.fil.* -> all((v, x) => v.filEnv.<same>)
  filter.envAmount -> all((v, x) => v.setFilterEnvAmount(x))   # semitone depth
  filter.velAmount -> all((v, x) => v.setFilterVelAmount(x))   # v3, REQ-5
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

Scenario: Velocity leaves the filter alone by default (v3, REQ-5, ADR-006)
  Given filter.velAmount is 0 (the default)
  When notes trigger at velocity 0.2 and at 1.0
  Then both trigger the filter envelope at peak 1 — the pre-v3 behaviour exactly
# pinned by: tests/audio/voice.test.ts

Scenario: A harder note opens the filter further (v3, REQ-5)
  Given filter.velAmount is 1
  When a note triggers at velocity 0.25
  Then the filter envelope peaks at 0.25, so the sweep is a quarter as deep
  And the amp envelope's own peak is unchanged by the setting
# pinned by: tests/audio/voice.test.ts

Scenario: Partial velocity tracking interpolates (v3, REQ-5, edge)
  Given filter.velAmount is 0.5
  When a note triggers at velocity 0
  Then the filter envelope peaks at 0.5 — half depth, never silence
# pinned by: tests/audio/voice.test.ts

Scenario: A sequenced gated note releases with a ramp, not a snap (regression)
  Given the sequencer schedules a step's attack at a future `when` and its
    release at a future `gateEnd` on the same tick (note not yet sounding)
  When release_(gateEnd) runs
  Then the release anchors at the sustain-level value the curve reaches at
    gateEnd — not the pre-attack live param value (~0), which cut the note
    instantly and clicked
# pinned by: tests/audio/envelope.test.ts
```

## Tests & verification

- `tests/state/params.test.ts`, `tests/audio/envelope.test.ts` (scheduled-automation
  model, REQ-4), `e2e/controls.spec.ts`.
- `npm test` / `npm run e2e` / `npm run typecheck`.

## Open questions / future

- Keep filter-env modulation in semitones — never re-express cutoff in Hz in the
  audio path (shared invariant with [ladder-filter](ladder-filter.md) and
  [lfo](lfo.md)).
