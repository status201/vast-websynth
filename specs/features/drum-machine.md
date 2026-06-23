# Drum machine

```yaml
id: drum-machine
status: implemented
version: 1
owner: core
related:
  - architecture
  - step-settings
  - banks
  - sampler
source:
  - src/audio/transport/drum-machine.ts
  - src/audio/drums/drum-synths.ts
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/drum-panel.ts
```

An 8-track synthesised drum machine on its own bus, sharing the
[per-step settings](step-settings.md) and [bank](banks.md) machinery with the
sequencer and [sampler](sampler.md).

## Background / Why

The drum voices are synthesised (not samples), so they are cheap one-shot graphs
created inside `trigger()` and bounded by their envelope. Each track has volume,
pitch (tune), and decay. The machine plays the drum **play bank** chosen by the
[arrangement](arrangement.md), supports the choke model for short gates, and can
play a **fill** roll when [performance](performance.md) requests it.

## Requirements

- **REQ-1** — 8 fixed tracks: Kick, Snare, Closed Hat, Open Hat, Low/Mid/High Tom,
  Clap (order matches `DRUM_TRACKS`).
- **REQ-2** — Per-track volume / tune (semitones) / decay / mute.
- **REQ-3** — One-shot hits honour velocity/prob/ratchet; gate < 1 chokes the hit
  early (downstream gain), gate 1 is natural decay, tie rings into the next step.
- **REQ-4** — Reads `patterns.drumBank(arrangement.drumPlayBank)` each tick.
- **REQ-5** — When `performance.fillActive`, play a roll instead of the pattern.

## Technical design

### Contract / public interface

```yaml
DrumMachine:  # src/audio/transport/drum-machine.ts
  tracks: DrumSynth[]; trackGains: GainNode[]; muted: boolean[]
  setEnabled(on)
  setTrackVolume(i, v) / setTrackTune(i, semis) / setTrackDecay(i, s) / setTrackMute(i, b)
  onStep(fn) -> unsubscribe
DrumSynth:    # src/audio/drums/drum-synths.ts
  output: AudioNode
  trigger(when, velocity, chokeAt?)   # chokeAt cuts the hit with a fast fade
  setTune(semitones) / setDecay(seconds)
```

### Data shapes (registry)

```yaml
drum.on:     { discrete, labels: [off, on], default: 0 }
drum.master: { range: 0..1, default: 0.85 }     # drum bus volume
drum.mute / drum.solo:  # lane mixer (song-mode)
# per track i in 0..7:
drum.t{i}.vol:   { range: 0..1, default: 0.85 }
drum.t{i}.tune:  { range: -24..24, default: 0, step: 1, unit: st }
drum.t{i}.decay: { range: 0.02..1.5, default: 0.3, format: ms }
drum.t{i}.mute:  { discrete, labels: [on, mute], default: 0 }
# step grid: DrumCell[track][step] in PatternStore — see step-settings.md
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  drum.on -> setEnabled; drum.master -> drumVol + applyLaneMix
  drum.t{i}.* -> setTrackVolume/ Tune/ Decay/ Mute
hit math: stepHits + chokeAt + rollProb (step-hits.ts); choke via chokeRoute (drum-synths.ts)
graph: track.output -> trackGain -> drumBus -> drumComp -> drumPhaser -> drumDelay -> preMaster
ui: src/ui/panels/drum-panel.ts (drum-step-<t>-<s> grid + per-track controls)
```

## Scenarios (BDD)

```gherkin
Scenario: A short gate chokes the hit early
  Given a kick step with gate 0.5
  When it fires
  Then a downstream gain ramps to 0 at gateEnd, cutting the tail without retuning the envelope
# pinned by: tests/audio/drums/drum-synths.test.ts, tests/audio/transport/step-hits.test.ts

Scenario: Fill plays a roll instead of the pattern (edge)
  Given performance.fillActive is true
  When the bar plays
  Then the drum machine plays a roll rather than the programmed cells
# pinned by: tests/audio/transport/drum-machine.test.ts, e2e/song-fx.spec.ts
```

## Tests & verification

- `tests/audio/transport/drum-machine.test.ts`,
  `tests/audio/drums/drum-synths.test.ts`, `e2e/patterns.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- Track count/order is fixed (`DRUM_TRACK_COUNT`); adding a track touches the
  voice list, `DRUM_TRACK_LABELS`, the per-track params, and the grid UI.
