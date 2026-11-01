# Drum machine

```yaml
id: drum-machine
status: implemented
version: 14
owner: core
related:
  - architecture
  - step-settings
  - step-grid-editing
  - banks
  - sampler
  - drum-kits
  - sidechain-ducking
  - meter
source:
  - src/audio/transport/drum-machine.ts
  - src/audio/drums/drum-synths.ts
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/drum-panel.ts
```

An 8-track synthesised drum machine on its own bus, sharing the
[per-step settings](step-settings.md), [bank](banks.md) and
[grid-gesture](step-grid-editing.md) machinery with the sequencer and
[sampler](sampler.md). Each track is sound-designable: tune, decay, tone, drive, pan
and volume.

## Background / Why

The voices are synthesised, so a hit is a cheap one-shot graph built in `trigger()` and
bounded by its envelope. Tune and decay live inside the voice; tone, drive and pan are
a per-track **channel** downstream of it, so the voice DSP and the choke model are
untouched. The machine plays the drum **play bank** chosen by the
[arrangement](arrangement.md) and a **fill** roll when [performance](performance.md)
asks. Bulk tweaks (factory kits, randomize) are [drum-kits](drum-kits.md).

## Requirements

- **REQ-eight-fixed-drum-tracks** — 8 fixed tracks: Kick, Snare, Closed Hat, Open Hat,
  Low/Mid/High Tom, Clap (the order of `DRUM_TRACKS`).
- **REQ-per-track-drum-params** — Per-track volume / tune (semitones) / decay / tone /
  drive / pan / mute.
- **REQ-hits-honour-velocity-and-ratchet** — Hits honour velocity/prob/ratchet. Gate
  < 1 chokes the hit early (a downstream gain), gate 1 is the natural decay, and a tie
  rings into the next step.
- **REQ-the-drums-read-their-play-bank** — It reads
  `patterns.drumBank(arrangement.drumPlayBank)` each tick.
- **REQ-fill-plays-a-roll** — While `performance.fillActive`, it plays a roll instead
  of the pattern.
- **REQ-tune-is-audible-on-every-voice** — `tune` shifts every voice's noise/tone
  filters and oscillators by `2^(tune/12)`, not only Kick/Tom.
- **REQ-tone-drive-and-pan-are-a-channel** — Tone, drive and pan are a per-track
  channel between the voice `output` and the drum bus, leaving the envelope and choke
  intact. All three default to a **no-op** (tone open, drive off, pan centre).
- **REQ-a-selected-drum-tuning-strip** — The panel has a **selected-drum tuning strip**
  (tune/decay/tone/drive/pan/vol + Reset) on the per-step editor's selection cursor.
  Clicking a track label selects **and** auditions it. Reset returns that track's
  params to their registered defaults.
- **REQ-per-hit-nodes-are-disposable** — A hit's per-hit nodes (oscillators, noise
  sources, filters, envelope gains, the choke gain) are **disconnected once its
  sources end** (the last `onended` of a multi-source voice). Only the persistent
  per-synth `output` survives. A long song must not accumulate stopped-but-connected
  nodes, which crackle over time.
- **REQ-the-strip-rebuilds-only-on-selection** — The tuning strip is **rebuilt only
  when the selected track changes**, not on a step click; its knobs already follow the
  bus. Each rebuilt `Knob` is `destroy()`ed and leaves **no window pointer listeners**
  (the drag-scoped-listener rule in
  [add-a-ui-component](../recipes/add-a-ui-component.md)), or repeated edits starve the
  audio callback.
- **REQ-a-drum-tracks-algorithm-is-selectable** (v5) — `drum.t{i}.model` selects a
  track's voice from `DRUM_MODEL_LABELS`: the 8 classic voices (0–7, in track order)
  plus Conga, Bongo, Cowbell, Clave and Shaker (8–12), built by `MODEL_BUILDERS`.
  - The **default is the track's own index**, so a file without the param plays the
    classic kit.
  - A swap replaces only the voice: the new one is wired into the **same** channel
    (REQ-tone-drive-and-pan-are-a-channel), cached tune/decay are replayed, and
    tone/drive/pan/vol/mute and the grid are untouched
    (REQ-swapping-a-model-never-severs-a-voice says how the old one leaves).
  - Every model honours the whole `DrumSynth` contract (tune, decay, choke, per-hit
    teardown). The percussion voices follow ADR-010: small graphs, constants by ear.
  - The author dialect's track names (`kick`/`chat`/`ltom`…) name the **slot**, not the
    model; `drum.t{i}.model` travels in `params`.
  - UI: a per-track **model dropdown** (`drum-model`) in the tuning strip, and the row
    label shows the model's name (`DRUM_TRACK_LABELS` stay the slot names).
- **REQ-a-closed-hat-cuts-an-open-hat** (v6) — `drum.choke` (discrete, **default 0 =
  off**, since switching it on changes how songs sound — ADR-006) makes a closed hat
  cut an open hat, as the shared hat voice of an 808/909 does.
  - The group is by **model, not track index**: any track whose model is `C.Hat` cuts
    every track whose model is `O.Hat`.
  - **The cut ends the ringing open-hat hits, not the track.** A closed hat at `when`
    calls `cut(when)` on every open-hat voice, which fades each of its hits that started
    before `when` and is still sounding, over `CHOKE_FADE`, on that hit's own gain
    (after its envelope, before drive, so a cut tail is never saturated). The gain
    never comes back up, so the next open hat is a new hit at full level. The hit's
    noise source stops just after the fade. A hit starting at the same instant is not
    cut, so track order does not matter. `drum.t{i}.vol` is never touched. Deliberate:
    don't reintroduce a per-track group gain that is restored after the cut; the
    350 ms tail it cut comes straight back.
  - It is scheduled at `when`, so it lands sample-accurately inside the look-ahead.
  - A closed hat does not choke itself, and nothing chokes kick/snare/tom. A general
    choke matrix is out of scope.
- **REQ-every-sounded-hit-is-reported** (v7) — `onHit(track, when, velocity)` fires for
  each hit as it is scheduled, with the absolute time it sounds. One private `fire()`
  carries every trigger path (the pattern sweep, the fill, the audition), so a hit
  cannot sound unreported or be reported without sounding. It fires inside
  `forEachActiveHit`, so muted tracks and failed probability rolls are excluded, and
  each ratchet sub-hit is its own report. It is not `onStep` (a mapped step index for
  the playhead, with no time). Its consumer is [sidechain-ducking](sidechain-ducking.md)
  REQ-on-hit-reports-only-sounded-hits.
  - **Reported ⇔ audible.** A per-track mute stops the hit outright. A **lane** mute,
    or a solo elsewhere, silences the bus while the voices still fire (so un-mute is
    instant); `LaneMixer.apply` pushes the `audibleLanes` verdict through
    `setLaneAudible`, so those hits are not reported either.
  - A mute does not retract reports already made up to one look-ahead ago.
    Deliberate: every consumer's envelope decays to rest within a release
    ([sidechain-ducking](sidechain-ducking.md) REQ-the-resting-duck-state-is-unity).
- **REQ-drum-lane-follows-the-meter** (v9) — `drum.len` / `drum.rate` size the window
  ([meter](meter.md) REQ-each-machine-has-a-loop-length/REQ-each-machine-has-a-step-rate),
  and `playFill` is written against it: the kick anchors each half-lane, the L→M→H tom
  roll takes the last quarter, and the clap accents the last step. At 16 cells this is
  the classic fill.
- **REQ-a-voice-envelope-reaches-true-zero** (v10) — An exponential ramp cannot reach 0
  and stops on a 0.001 floor, and stopping a source there is a step, i.e. a click.
  Every envelope ends with a linear ramp to **exactly 0** (`TAIL_FADE`) and its source
  stops at the end of it. Every source with its own envelope gets one (Snare noise and
  tone, Conga skin and overtone, Bongo head and click, the Cowbell's shared bandpass).
  It matters because the track drive (`tanh(k·x)/tanh(k)`, `k = drive × 50`) lifts
  the residue ~30 dB, which is plainly audible on the Kick's bare 55 Hz sine.
  `decayEnv()` owns the envelope shape and `finishHit()` the teardown, including the
  per-hit choke gain.
- **REQ-the-choke-group-restores-on-a-ramp** (v10) — Superseded by
  REQ-a-closed-hat-cuts-an-open-hat's per-hit cut, which has no group gain to restore.
  The id stays because tests and history cite it.
- **REQ-a-clamped-hit-carries-its-choke** (v10) — A voice starts at `max(when,
  currentTime)`, since `when` can be in the past (an early micro nudge,
  [step-settings](step-settings.md) REQ-an-early-offset-is-capped-in-seconds; the
  short lead after `start()` or a dropout). `chokeAt` shifts by the same delta, so the
  gate keeps its length and a hit is never cut mid-attack or silently dropped
  ([sampler](sampler.md) REQ-a-slot-starts-from-zero is the same rule).
- **REQ-tune-reads-in-semitones** (v11) — `drum.t{i}.tune` formats through `fmtSemi`
  (`+7st`). `formatParam` reads only `format`; `unit: 'st'` stays for the generated
  catalogue (`public/params.json`, MCP `get_params`).
- **REQ-swapping-a-model-never-severs-a-voice** (v12) — A model swap ramps the outgoing
  voice's `output.gain` to 0 over `RAMP_MEDIUM`, wires the new voice **immediately**
  (silent until triggered), and `disconnect()`s the old one from a 40 ms timer. Stop
  does not silence drum hits, and a song load writes `drum.t{i}.model` twice
  ([song-mode](song-mode.md) REQ-applying-a-song-is-click-free), so an instant
  disconnect clicked. **Ungated**, unlike `ModMatrix.patch`: each pending timer owns a
  different discarded voice, and a generation guard would leak one. `DrumSynth.output`
  is a `GainNode` for this. In-flight one-shots keep their own teardown.

## Technical design

### Contract / public interface

```yaml
DrumMachine:  # src/audio/transport/drum-machine.ts
  tracks: DrumSynth[]; trackGains: GainNode[]; muted: boolean[]
  setEnabled(on)
  setTrackVolume(i, v) / setTrackTune(i, semis) / setTrackDecay(i, s) / setTrackMute(i, b)
  setTrackTone(i, amt) / setTrackDrive(i, amt) / setTrackPan(i, p)
  setTrackModel(i, model)              # swap the voice (REQ-swapping-a-model-never-severs-a-voice)
  setLaneAudible(on)                   # the lane mixer's mute/solo verdict
  triggerTrack(i, velocity)            # UI audition
  onStep(fn) -> unsubscribe
  onHit(fn: (track, when, velocity) => void) -> unsubscribe
MODEL_BUILDERS: ((ctx, noise) => DrumSynth)[]   # drum-machine.ts, index = model value
DRUM_MODEL_LABELS: string[]  # dropdown labels, index = model value (state/params.ts)
DrumSynth:    # src/audio/drums/drum-synths.ts
  output: GainNode
  trigger(when, velocity, chokeAt?)   # chokeAt cuts the hit with a fast fade
  setTune(semitones)
  setDecay(seconds)
  cut?(when)                          # the open hat: fade its ringing hits
```

### Data shapes (registry)

```yaml
drum.on:     { discrete, labels: [off, on], default: 0 }
drum.master: { range: 0..1, default: 0.85 }     # drum bus volume
drum.choke:  { discrete, labels: [off, on], default: 0 }
drum.mute / drum.solo:  # lane mixer (song-mode)
# per track i in 0..DRUM_TRACK_COUNT-1:
drum.t{i}.vol:   { range: 0..1, default: 0.85 }
drum.t{i}.tune:  { range: -24..24, default: 0, step: 1, unit: st }
drum.t{i}.decay: { range: 0.02..1.5, default: 0.3, format: ms }
drum.t{i}.tone:  { range: 0..1, default: 1, format: pct }   # 1 = open (no-op), lower darkens
drum.t{i}.drive: { range: 0..1, default: 0, format: pct }   # 0 = clean (no-op)
drum.t{i}.pan:   { range: -1..1, default: 0, format: L/C/R } # 0 = centre (no-op)
drum.t{i}.mute:  { discrete, labels: [on, mute], default: 0 }
drum.t{i}.model: { range: 0..12, default: i, step: 1, taper: discrete, labels: DRUM_MODEL_LABELS }
# step grid: DrumCell[track][step] in PatternStore — see step-settings.md
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  drum.on -> setEnabled; drum.master -> laneMixer.setDrumVol
  drum.t{i}.* -> setTrackVolume/ Tune/ Decay/ Tone/ Drive/ Pan/ Mute/ Model
    (loop runs DRUM_TRACK_COUNT, not a literal 8)
hit math: stepHits + chokeAt + rollProb (step-hits.ts); choke via chokeRoute (drum-synths.ts)
graph: voice.output -> drive(preGain->waveShaper->postGain) -> tone(lowpass biquad)
         -> trackGain -> pan(StereoPanner) -> drumBus -> the drum chain (effects.md) -> preMaster
ui: src/ui/panels/drum-panel.ts (drum-step-<t>-<s> grid + per-track mute + the sound-design
    row: KIT dropdown + randomize, then the tuning strip knob-drum.t<i>.{tune,decay,tone,drive,pan,vol}
    + drum-reset — see drum-kits.md)
```

### Persistence

The per-track params are bus scalars, captured by presets and songs through
`bus.snapshot()`/`restore()`. No-op defaults keep existing files sounding the same.

## Scenarios (BDD)

```gherkin
Scenario: A model swap never severs a ringing voice (REQ-swapping-a-model-never-severs-a-voice)
  Given a track's voice is still sounding after the transport stopped
  When the track's model is changed
  Then the outgoing voice's output is ramped to zero, not disconnected in that turn
   And it is disconnected only after the fade window
   And the replacement voice is wired in immediately
# pinned by: tests/audio/drums/drum-machine-model.test.ts

Scenario: Two model swaps in one window each tear down their own voice (edge)
  Given a model swap is still inside its fade window
  When the model changes again
  Then both superseded voices are eventually disconnected
   And the surviving voice is not
# pinned by: tests/audio/drums/drum-machine-model.test.ts

Scenario: TUNE reads as semitones, not a bare number (REQ-tune-reads-in-semitones, regression)
  Given drum.t0.tune is +7
  When its knob renders its value
  Then it reads "+7st" — never "7.00", which is what a unit with no format gives
# pinned by: tests/ui/format-param.test.ts

Scenario: A voice never stops on a non-zero envelope (REQ-a-voice-envelope-reaches-true-zero, regression)
  Given any of the 13 drum voice models
  When it is triggered
  Then its envelope ends with a linear ramp to exactly 0
  And every source stops at or after that ramp completes, never on the 0.001 floor
# pinned by: tests/audio/drums/drum-synths.test.ts

Scenario: The kick's tail no longer steps (REQ-a-voice-envelope-reaches-true-zero, regression)
  Given a kick whose track drive amplifies quiet residue ~32x
  When the hit ends
  Then the largest sample-to-sample step is bounded by the 55 Hz sine itself
  And not by the truncation that used to leave a ~0.13 step at -30 dBFS
# pinned by: tests/audio/drums/drum-synths.test.ts, npm run bench:metrics (by ear, ADR-010)

Scenario: A cut open hat stays cut (REQ-a-closed-hat-cuts-an-open-hat, regression; supersedes REQ-the-choke-group-restores-on-a-ramp)
  Given choke is on and an open hat ringing on its 350 ms decay
  When a closed hat fires 100 ms in
  Then that open-hat hit fades to 0 over CHOKE_FADE and nothing raises it again
  And an open hat fired after the closed hat sounds at full level
# pinned by: tests/audio/drums/drum-synths.test.ts, tests/audio/transport/drum-machine.test.ts,
#            npm run bench:audio (by ear, ADR-010)

Scenario: A hit clamped out of the past keeps its gate length (REQ-a-clamped-hit-carries-its-choke, regression)
  Given a step whose scheduled time has already passed
  And a gate < 1 that would choke it
  When the voice clamps its start forward to now
  Then the choke time shifts by the same delta, so the gate keeps its length
  And the hit is neither cut mid-attack nor dropped
# pinned by: tests/audio/drums/drum-synths.test.ts

Scenario: A short gate chokes the hit early
  Given a kick step with gate 0.5
  When it fires
  Then a downstream gain ramps to 0 at gateEnd, cutting the tail without retuning the envelope
# pinned by: tests/audio/drums/drum-synths.test.ts, tests/audio/transport/step-hits.test.ts

Scenario: Tune shifts a noise voice (REQ-tune-is-audible-on-every-voice)
  Given a snare/hat/clap voice with tune +12
  When it fires
  Then its filter/oscillator frequencies are scaled by 2^(12/12) = 2x vs tune 0
# pinned by: tests/audio/drums/drum-synths.test.ts

Scenario: A track has its own tone/drive/pan channel (REQ-tone-drive-and-pan-are-a-channel)
  Given the drum machine is constructed
  Then each track wires voice.output -> drive -> tone -> gain -> pan -> drumBus
  And setTrackTone/Drive/Pan adjust that track's channel without touching other tracks
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: Reset restores a track's defaults (REQ-a-selected-drum-tuning-strip)
  Given track 0's tune/tone/drive/pan have been changed
  When the tuning-strip Reset is pressed
  Then those params return to their registered defaults
# pinned by: e2e/drum-kit.spec.ts

Scenario: Fill plays a roll instead of the pattern (edge)
  Given performance.fillActive is true
  When the bar plays
  Then the drum machine plays a roll rather than the programmed cells
# pinned by: tests/audio/transport/drum-machine.test.ts, e2e/song-fx.spec.ts

Scenario: Switching a voice model swaps the voice, not the channel (REQ-a-drum-tracks-algorithm-is-selectable)
  Given track 4 (L.Tom slot) with a tuned channel (pan/drive set)
  When drum.t4.model is set to Conga
  Then a Conga instance is wired into the same channel, cached tune/decay are
       replayed, and pan/drive are unchanged
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: Old songs keep the classic voices (REQ-a-drum-tracks-algorithm-is-selectable, no-op default)
  Given a song file that never mentions drum.t{i}.model
  When it is applied
  Then every track's model equals its own index (the classic voice)
# pinned by: tests/state/params.test.ts

Scenario: A hit disconnects its one-shot nodes once it ends (REQ-per-hit-nodes-are-disposable, regression)
  Given a drum voice is triggered
  When the hit's source(s) finish (onended fires; the last one for a multi-source voice)
  Then every per-hit node it created is disconnected, including the choke gain when choked
  And the persistent per-synth output gain is never disconnected
# pinned by: tests/audio/drums/drum-synths.test.ts

Scenario: Step clicks don't rebuild the tuning strip or leak listeners (REQ-the-strip-rebuilds-only-on-selection, regression)
  Given the drum tuning strip shows track T's knobs
  When the user clicks steps within track T repeatedly
  Then the tuning knobs are not rebuilt (a rebuild happens only when the selected track changes)
  And a destroyed Knob has removed every window pointer listener it added
# pinned by: tests/ui/knob.test.ts

Scenario: A closed hat cuts the open hat once choke is on (REQ-a-closed-hat-cuts-an-open-hat)
  Given drum.choke is on, with a C.Hat and an O.Hat track
  When the closed hat fires
  Then every open-hat voice is told to cut its ringing hits at that time
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: Choke is off by default, so no shipped song changes (REQ-a-closed-hat-cuts-an-open-hat, ADR-006)
  Given drum.choke at its default 0
  When a closed hat fires over a ringing open hat
  Then nothing is choked
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: The group follows the voice model, not the track (REQ-a-closed-hat-cuts-an-open-hat)
  Given the O.Hat model has been moved onto another track
  When a closed hat fires
  Then the relocated open hat is choked and the vacated slot is not
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A ratcheted closed hat chokes on every sub-hit (REQ-a-closed-hat-cuts-an-open-hat, edge)
  Given a closed-hat step with ratchet 3 and choke on
  Then the open-hat voice is told to cut three times, at each sub-hit's own time
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A hit is reported with its track, scheduled time and velocity (REQ-every-sounded-hit-is-reported)
  Given a listener registered through onHit
  When an active cell plays
  Then it receives the track index, the absolute time the hit sounds and the cell velocity
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A ratcheted step reports one hit per sub-hit (REQ-every-sounded-hit-is-reported)
  Given a step with ratchet 4
  When it plays
  Then onHit fires four times, at four distinct ascending times
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A hit that does not sound is not reported (REQ-every-sounded-hit-is-reported, edge)
  Given a step on a muted track, or one whose probability roll fails,
        or a machine that is disabled
  When the tick is swept
  Then onHit does not fire
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A lane mute stops the reports too (REQ-every-sounded-hit-is-reported, regression)
  Given an active drum pattern being reported through onHit
  When the drum LANE is muted, silencing the bus without stopping the pattern
  Then onHit stops firing, so a trigger-keyed effect stops pumping
   And it resumes on un-mute
# pinned by: tests/audio/transport/drum-machine.test.ts, tests/audio/lane-mixer.test.ts

Scenario: Soloing another lane stops them as well (REQ-every-sounded-hit-is-reported, regression)
  Given an active drum pattern being reported through onHit
  When the sequencer lane is soloed, so the drum bus is silenced
  Then onHit stops firing, because audibility — not the mute flag — is the rule
# pinned by: tests/audio/lane-mixer.test.ts

Scenario: A manual audition is reported too (REQ-every-sounded-hit-is-reported)
  Given a listener registered through onHit
  When triggerTrack auditions a pad
  Then onHit fires at the current time, so an auditioned drum drives a ducker
# pinned by: tests/audio/transport/drum-machine.test.ts
```

## Tests & verification

- `tests/audio/transport/drum-machine.test.ts`, `tests/audio/drums/drum-synths.test.ts`,
  `tests/audio/drums/drum-machine-model.test.ts`, `tests/state/params.test.ts`,
  `e2e/patterns.spec.ts`, `e2e/drum-kit.spec.ts` — `npm test` / `npm run e2e`.

## Open questions / future

- The track count is fixed (`DRUM_TRACK_COUNT`). A new *voice* is a `MODEL_BUILDERS`
  entry plus a `DRUM_MODEL_LABELS` append ([add-a-drum-voice](../recipes/add-a-drum-voice.md)),
  with no schema change.
