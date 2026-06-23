# Oscillators & mixer (sound sources)

```yaml
id: oscillators
status: implemented
version: 1
owner: core
related:
  - architecture
  - voicing
  - ladder-filter
source:
  - src/audio/oscillator.ts
  - src/audio/voice.ts
  - src/state/params.ts
  - src/audio/engine.ts        # subscribeParams (osc1/osc2/sub/noise)
  - src/ui/app.ts
```

The synth's tone sources: two main oscillators, a sub-oscillator, and a noise
mixer — the raw signal before the [filter](ladder-filter.md) and FX.

## Background / Why

A classic subtractive-synth front end. Two detunable oscillators give body and
movement (beating when detuned); the sub adds weight an octave (or two) down; the
noise source adds breath/percussive transient material. Each is a plain bundle of
scalar params, so they snapshot into presets/songs for free.

## Requirements

- **REQ-1** — Two main oscillators, each with waveform / octave / fine detune /
  level.
- **REQ-2** — A sub-oscillator with waveform / octave (only `-2..-1`) / level,
  defaulting to **level 0** (no-op for existing presets).
- **REQ-3** — A noise level in the mixer, default 0.
- **REQ-4** — Every change applies to **all 8 voices** live (via the `all(...)`
  fan-out).

## Technical design

### Data shapes (registry)

```yaml
osc1.wave:   { discrete, labels: WAVE_LABELS, range: 0..3, default: 2 }
osc1.octave: { range: -2..2, default: 0, unit: oct }
osc1.detune: { range: -50..50, default: 0, unit: cents }
osc1.level:  { range: 0..1, default: 0.7 }
osc2.*:      # same shape; osc2.detune default 7 (slight beating out of the box)
sub.wave:    { discrete, labels: WAVE_LABELS, range: 0..3, default: 0 }
sub.octave:  { range: -2..-1, default: -1, unit: oct }
sub.level:   { range: 0..1, default: 0 }      # no-op default
mixer.noise: { range: 0..1, default: 0 }       # no-op default
```

### Layer touchpoints

```yaml
registry: src/state/params.ts -> registerDefaults()
engine:   src/audio/engine.ts -> subscribeParams()
  osc1.*  -> all((v, x) => v.osc1.setWave/ setOctave/ setDetuneCents/ setLevel)
  osc2.*  -> all((v, x) => v.osc2.<same>)
  sub.*   -> all((v, x) => v.setSubWave/ setSubOctave/ setSubLevel)
  noise   -> all((v, x) => v.setNoiseLevel(x))
ui:       src/ui/app.ts  (OSC1 / OSC2 / SUB panels: Knob + Segmented for wave)
```

Each `Voice` (`src/audio/voice.ts`) owns its own `Oscillator` instances
(`src/audio/oscillator.ts`); detune is in **cents**, octave in whole octaves.

## Scenarios (BDD)

```gherkin
Scenario: Detuning osc2 thickens the sound
  Given the engine is running
  When the user sets osc2.detune to 12
  Then every voice's osc2 is 12 cents sharp and beats against osc1
# pinned by: tests/state/params.test.ts, e2e/controls.spec.ts

Scenario: Sub level defaults to silent (backward compat, edge)
  Given a preset that never set sub.level
  Then sub.level is 0 and the sub-oscillator is inaudible
# pinned by: tests/state/params.test.ts (default), tests/state/preset.test.ts
```

## Tests & verification

- `tests/state/params.test.ts` (registration/defaults/clamp).
- `e2e/controls.spec.ts` (control surface). `npm test` / `npm run e2e`.

## Open questions / future

- `WAVE_LABELS` order is defined in `params.ts`; a 5th waveform would extend the
  discrete range + labels and need no engine change beyond `Oscillator.setWave`.
