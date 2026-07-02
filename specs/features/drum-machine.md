# Drum machine

```yaml
id: drum-machine
status: implemented
version: 3
owner: core
related:
  - architecture
  - step-settings
  - banks
  - sampler
  - drum-kits
source:
  - src/audio/transport/drum-machine.ts
  - src/audio/drums/drum-synths.ts
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/drum-panel.ts
```

An 8-track synthesised drum machine on its own bus, sharing the
[per-step settings](step-settings.md) and [bank](banks.md) machinery with the
sequencer and [sampler](sampler.md). Each track is sound-designable: pitch
(tune), length (decay), brightness (tone), grit (drive), stereo position (pan),
and volume.

## Background / Why

The drum voices are synthesised (not samples), so they are cheap one-shot graphs
created inside `trigger()` and bounded by their envelope. The voice algorithms are
fixed, but each track is *parameterised* so users can shape a kit rather than be
stuck with one fixed sound: tune/decay live inside the voice, while tone/drive/pan
are applied uniformly by a per-track **channel** downstream of the voice (so the
voice DSP is untouched and the choke model is unaffected). The machine plays the
drum **play bank** chosen by the [arrangement](arrangement.md), supports the choke
model for short gates, and can play a **fill** roll when
[performance](performance.md) requests it. Bulk per-track tweaks (factory kits,
randomize) are layered on top in [drum-kits](drum-kits.md).

## Requirements

- **REQ-1** — 8 fixed tracks: Kick, Snare, Closed Hat, Open Hat, Low/Mid/High Tom,
  Clap (order matches `DRUM_TRACKS`).
- **REQ-2** — Per-track volume / tune (semitones) / decay / tone / drive / pan /
  mute.
- **REQ-3** — One-shot hits honour velocity/prob/ratchet; gate < 1 chokes the hit
  early (downstream gain), gate 1 is natural decay, tie rings into the next step.
- **REQ-4** — Reads `patterns.drumBank(arrangement.drumPlayBank)` each tick.
- **REQ-5** — When `performance.fillActive`, play a roll instead of the pattern.
- **REQ-6** — `tune` is audible on **every** voice (it shifts the noise/tone
  filters + oscillators by `2^(tune/12)`), not only Kick/Tom.
- **REQ-7** — Tone/drive/pan are applied by a per-track channel inserted between
  the voice `output` and the drum bus, leaving the voice envelope + choke intact.
  All three default to a **no-op** (tone open, drive off, pan centre).
- **REQ-8** — The drum panel exposes a **selected-drum tuning strip**
  (tune/decay/tone/drive/pan/vol knobs + a Reset) driven by the same selection
  cursor as the per-step editor; clicking a track label selects **and** auditions
  it. Reset returns that track's params to their registered defaults.
- **REQ-9** — Each one-shot hit's per-hit nodes (oscillators, noise sources,
  filters, envelope gains, and the choke gain when present) are **disconnected
  once the hit's source(s) end** — the hit's source `onended` tears them down
  (the last `onended` for a multi-source voice). Only the persistent per-synth
  `output` gain, built in the constructor and wired into the track channel once,
  survives. This bounds the live graph: a long song must not accumulate
  stopped-but-connected nodes (which crackle/distort the audio over time).

## Technical design

### Contract / public interface

```yaml
DrumMachine:  # src/audio/transport/drum-machine.ts
  tracks: DrumSynth[]; trackGains: GainNode[]; muted: boolean[]
  setEnabled(on)
  setTrackVolume(i, v) / setTrackTune(i, semis) / setTrackDecay(i, s) / setTrackMute(i, b)
  setTrackTone(i, amt) / setTrackDrive(i, amt) / setTrackPan(i, p)
  triggerTrack(i, velocity)            # UI audition
  onStep(fn) -> unsubscribe
DrumSynth:    # src/audio/drums/drum-synths.ts
  output: AudioNode
  trigger(when, velocity, chokeAt?)   # chokeAt cuts the hit with a fast fade
  setTune(semitones)                  # real on all voices (REQ-6)
  setDecay(seconds)
```

### Data shapes (registry)

```yaml
drum.on:     { discrete, labels: [off, on], default: 0 }
drum.master: { range: 0..1, default: 0.85 }     # drum bus volume
drum.mute / drum.solo:  # lane mixer (song-mode)
# per track i in 0..DRUM_TRACK_COUNT-1:
drum.t{i}.vol:   { range: 0..1, default: 0.85 }
drum.t{i}.tune:  { range: -24..24, default: 0, step: 1, unit: st }
drum.t{i}.decay: { range: 0.02..1.5, default: 0.3, format: ms }
drum.t{i}.tone:  { range: 0..1, default: 1, format: pct }   # 1 = open (no-op), lower darkens
drum.t{i}.drive: { range: 0..1, default: 0, format: pct }   # 0 = clean (no-op)
drum.t{i}.pan:   { range: -1..1, default: 0, format: L/C/R } # 0 = centre (no-op)
drum.t{i}.mute:  { discrete, labels: [on, mute], default: 0 }
# step grid: DrumCell[track][step] in PatternStore — see step-settings.md
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  drum.on -> setEnabled; drum.master -> laneMixer.setDrumVol
  drum.t{i}.* -> setTrackVolume/ Tune/ Decay/ Tone/ Drive/ Pan/ Mute
    (loop runs DRUM_TRACK_COUNT, not a literal 8)
hit math: stepHits + chokeAt + rollProb (step-hits.ts); choke via chokeRoute (drum-synths.ts)
graph: voice.output -> drive(preGain->waveShaper->postGain) -> tone(lowpass biquad)
         -> trackGain -> pan(StereoPanner) -> drumBus -> drumComp -> drumPhaser -> drumDelay -> drumReverb -> preMaster
ui: src/ui/panels/drum-panel.ts (drum-step-<t>-<s> grid + per-track mute +
    a sound-design row below the grid: KIT dropdown + randomize then a
    selected-drum tuning strip knob-drum.t<i>.{tune,decay,tone,drive,pan,vol} +
    drum-reset — see drum-kits.md)
```

The per-track channel sits **downstream** of the voice `output`, so it never
disturbs the envelope ramps the voice schedules internally, and `chokeRoute`
(which the voice applies upstream) keeps working unchanged.

### Persistence

The per-track params are plain scalars in the bus, so they are captured by presets
and songs automatically via `bus.snapshot()`/`restore()` (no new file fields). No-op
defaults keep existing presets/songs sounding identical.

## Scenarios (BDD)

```gherkin
Scenario: A short gate chokes the hit early
  Given a kick step with gate 0.5
  When it fires
  Then a downstream gain ramps to 0 at gateEnd, cutting the tail without retuning the envelope
# pinned by: tests/audio/drums/drum-synths.test.ts, tests/audio/transport/step-hits.test.ts

Scenario: Tune shifts a noise voice (REQ-6)
  Given a snare/hat/clap voice with tune +12
  When it fires
  Then its filter/oscillator frequencies are scaled by 2^(12/12) = 2x vs tune 0
# pinned by: tests/audio/drums/drum-synths.test.ts

Scenario: A track has its own tone/drive/pan channel (REQ-7)
  Given the drum machine is constructed
  Then each track wires voice.output -> drive -> tone -> gain -> pan -> drumBus
  And setTrackTone/Drive/Pan adjust that track's channel without touching other tracks
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: Reset restores a track's defaults (REQ-8)
  Given track 0's tune/tone/drive/pan have been changed
  When the tuning-strip Reset is pressed
  Then those params return to their registered defaults
# pinned by: e2e/drum-kit.spec.ts

Scenario: Fill plays a roll instead of the pattern (edge)
  Given performance.fillActive is true
  When the bar plays
  Then the drum machine plays a roll rather than the programmed cells
# pinned by: tests/audio/transport/drum-machine.test.ts, e2e/song-fx.spec.ts

Scenario: A hit disconnects its one-shot nodes once it ends (REQ-9, regression)
  Given a drum voice is triggered
  When the hit's source(s) finish (onended fires; the last one for a multi-source voice)
  Then every per-hit node it created is disconnected, including the choke gain when choked
  And the persistent per-synth output gain is never disconnected
# pinned by: tests/audio/drums/drum-synths.test.ts
```

## Tests & verification

- `tests/audio/transport/drum-machine.test.ts`,
  `tests/audio/drums/drum-synths.test.ts`, `tests/state/params.test.ts`,
  `e2e/patterns.spec.ts`, `e2e/drum-kit.spec.ts`.
- `npm test` / `npm run e2e` / `npm run typecheck`.

## Open questions / future

- Track count/order is fixed (`DRUM_TRACK_COUNT`); adding a track touches the
  voice list, `DRUM_TRACK_LABELS`, the per-track params, and the grid UI
  (see `specs/recipes/add-a-drum-voice.md`).
- Voice *algorithms* are still fixed; swappable per-track voice models (e.g.
  808 vs 909 kick) remain a future option beyond parameterisation.
```
