# Drum machine

```yaml
id: drum-machine
status: implemented
version: 9   # v9: lane length/rate + a meter-relative fill (REQ-14) — meter.md
             # v8: REQ-13 — a lane mute (or a solo elsewhere) suppresses the hit
             #     report too, not just a per-track mute; "reported ⇔ audible"
             # v7: REQ-13 — onHit reports every hit that sounds, at its scheduled
             #     time; the sidechain ducker's trigger (sidechain-ducking.md)
             # v6: REQ-12 — an optional hat choke group (drum.choke, default off)
             # v5: per-track swappable voice models (drum.t{i}.model) + percussion voices
owner: core
related:
  - architecture
  - step-settings
  - step-grid-editing
  - banks
  - sampler
  - drum-kits
  - sidechain-ducking  # v7: the consumer REQ-13's onHit was added for
source:
  - src/audio/transport/drum-machine.ts
  - src/audio/drums/drum-synths.ts
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/drum-panel.ts
```

An 8-track synthesised drum machine on its own bus, sharing the
[per-step settings](step-settings.md), [bank](banks.md) and
[grid-gesture](step-grid-editing.md) machinery with the
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

- **REQ-10** — The selected-drum tuning strip is **rebuilt only when the selected
  track changes**, not on every step click (its knobs bind per-track paramIds that
  depend on the track alone; their displayed values already track the bus via
  subscription). Each rebuilt `Knob` is `destroy()`ed, and a destroyed Knob leaves
  **no window pointer listeners** behind — its drag listeners are attached on
  `pointerdown` and removed on `pointerup`/`destroy()` (the drag-scoped-listener
  rule in [add-a-ui-component](../recipes/add-a-ui-component.md)). This bounds the
  main-thread cost of drum editing: repeated step/track clicks must not accumulate
  dead window listeners or detached DOM, which otherwise starve the audio callback
  and crackle the audio *over time*.

- **REQ-11** (v5) — Each track's voice **algorithm is selectable** via a
  per-track discrete param `drum.t{i}.model`. The model list is the 8 classic
  voices (Kick, Snare, C.Hat, O.Hat, L/M/H Tom, Clap — indices 0–7, matching
  the track order) plus the percussion voices **Conga (8), Bongo (9),
  Cowbell (10), Clave (11), Shaker (12)**. Rules:
  - The **default is the track's own index**, so a song/preset that omits the
    param (every pre-v5 file) reproduces the classic kit exactly.
  - Switching models swaps only the voice instance: the old voice's `output` is
    disconnected and the new voice wired into the **same** per-track channel
    (drive→tone→gain→pan, REQ-7); cached tune/decay are replayed onto the new
    voice. Tone/drive/pan/vol/mute and the step grid are untouched.
  - Every model honours the full `DrumSynth` contract: tune (REQ-6), decay,
    choke (REQ-3), one-shot node teardown (REQ-9).
  - Percussion voices follow ADR-010 (musical, stable, cheap): small one-shot
    graphs, constants dialled by ear.
  - The author dialect's track names (`kick`/`chat`/`ltom`…) keep naming the
    **slot**, not the current model; `drum.t{i}.model` travels in `params` like
    any scalar.
  - UI: the sound-design row's tuning strip gains a per-track **model dropdown**
    (testid `drum-model`), and the grid's row label follows the selected model's
    name (the classic `DRUM_TRACK_LABELS` remain the slot names).

- **REQ-12** (v6) — **A closed hat can cut an open hat.** On a real 808/909 the
  two hats share one voice, so a closed hat ends whatever the open hat was doing;
  here every track is independent, so an open hat rang straight through the
  closed hats on top of it — the one thing that stops a hat pattern from
  breathing. `drum.choke` (discrete, **default 0 = off**) enables it. Rules:
  - **Off by default**, because switching it on changes how existing songs sound
    — the one thing [ADR-006](../decisions/adr-006-no-op-param-defaults.md)
    forbids a new param from doing. Every shipped demo is unaffected until
    someone reaches for the switch.
  - The group is decided by **model, not by track index** (REQ-11 makes models
    swappable): *any* track whose model is `C.Hat` chokes *every* track whose
    model is `O.Hat`. Move an open hat onto track 6 and it still chokes; put a
    cowbell on track 3 and it stops being choked.
  - The cut is a short fade on a dedicated per-track **choke gain** placed
    directly after the voice — upstream of drive, so a tail is cut before it is
    saturated — and the gain is restored immediately after the fade, so the next
    open-hat hit is at full level. It never touches `drum.t{i}.vol`, which is the
    user's.
  - It applies to **scheduled** hits (`when`), not to `currentTime`, so a choke
    lands sample-accurately inside the transport look-ahead like every other
    drum event.
  - A closed hat does **not** choke itself, and nothing chokes a kick/snare/tom —
    this is the hat pair only. A general per-track choke-group matrix is
    deliberately out of scope; see Open questions.

- **REQ-13** (v7) — **Every hit that sounds is reported, as it is scheduled.**
  `onHit(track, when, velocity)` fires for each hit the machine plays, carrying
  the absolute `AudioContext` time it will sound. Emitted from one private
  `fire()` that every trigger path routes through — the pattern sweep, the
  performance fill and the manual audition — so a hit can neither be reported
  without sounding nor sound without being reported. Because it fires from inside
  `forEachActiveHit`, muted lanes and failed probability rolls are already
  excluded and each ratchet sub-hit is its own emission at its own time.
  - This is **not** `onStep`, which carries a performance-mapped step index with
    no time and drives the UI playhead. A consumer that needs to schedule audio
    needs the time, and needs to know what actually sounded rather than what the
    grid says.
  - Added for [sidechain-ducking](sidechain-ducking.md) REQ-9, which is what
    keeps that feature from re-deriving mute/probability/ratchet rules — and so
    from drifting out of step with what is heard.
  - **(v8) A silenced lane reports nothing.** *Both* kinds of mute suppress the
    report, because both make the hit inaudible:
    - a **per-track** mute (`drum.t{i}.mute`) reaches `forEachActiveHit`, so the
      hit never happens at all;
    - a **lane** mute or a solo elsewhere silences the whole drum bus. The voices
      still fire — that is what makes un-mute instant (`LaneMixer`) — but nothing
      is heard, so nothing is reported. `LaneMixer.apply` pushes the
      `audibleLanes` verdict in via `setLaneAudible`, so **solo is honoured too**:
      soloing the sequencer stops the drums reporting exactly as muting them does.

    The rule is "reported ⇔ audible", not "reported ⇔ scheduled". Reporting a hit
    into a muted bus made a trigger-keyed effect pump to drums nobody could hear.
  - **(v8) A mute does not retract already-scheduled reports.** Hits are reported
    up to the clock's look-ahead (~100 ms) before they sound, so a mute can land
    after a report has gone out. A consumer therefore sees at most one look-ahead
    of stale triggers. Deliberate: the alternative is reaching into whatever a
    consumer already scheduled, and every consumer's envelope decays back to rest
    on its own within a release ([sidechain-ducking](sidechain-ducking.md) REQ-5).

- **REQ-14** (v9) — **The lane's length, rate and fill follow the meter.**
  `drum.len` / `drum.rate` size the played window ([meter](meter.md)
  REQ-10/REQ-14), and `playFill` is written against that window rather than a
  hard-coded 16: the kick anchors each half-lane, the L→M→H tom roll takes its
  last quarter, and the clap accents its **own** last step. At 16 cells every
  branch evaluates exactly as before (anchors on 0 and 8, roll from 12, clap on
  15), so a 4/4 fill is unchanged.

## Technical design

### Contract / public interface

```yaml
DrumMachine:  # src/audio/transport/drum-machine.ts
  tracks: DrumSynth[]; trackGains: GainNode[]; muted: boolean[]
  setEnabled(on)
  setTrackVolume(i, v) / setTrackTune(i, semis) / setTrackDecay(i, s) / setTrackMute(i, b)
  setTrackTone(i, amt) / setTrackDrive(i, amt) / setTrackPan(i, p)
  setTrackModel(i, model)              # swap the voice algorithm (REQ-11)
  triggerTrack(i, velocity)            # UI audition
  onStep(fn) -> unsubscribe
DRUM_MODEL_LABELS: string[]  # dropdown labels, index = model value (state/params.ts)
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
drum.t{i}.model: { range: 0..12, default: i, step: 1, taper: discrete,
                   labels: DRUM_MODEL_LABELS }   # default = the classic voice (REQ-11)
# step grid: DrumCell[track][step] in PatternStore — see step-settings.md
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  drum.on -> setEnabled; drum.master -> laneMixer.setDrumVol
  drum.t{i}.* -> setTrackVolume/ Tune/ Decay/ Tone/ Drive/ Pan/ Mute/ Model
    (loop runs DRUM_TRACK_COUNT, not a literal 8)
hit math: stepHits + chokeAt + rollProb (step-hits.ts); choke via chokeRoute (drum-synths.ts)
graph: voice.output -> choke(gain, REQ-12) -> drive(preGain->waveShaper->postGain)
         -> tone(lowpass biquad) -> trackGain -> pan(StereoPanner)
         -> drumBus -> drumComp -> drumPhaser -> drumDelay -> drumReverb -> preMaster
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
  Then each track wires voice.output -> choke -> drive -> tone -> gain -> pan -> drumBus
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

Scenario: Switching a voice model swaps the voice, not the channel (REQ-11)
  Given track 4 (L.Tom slot) with a tuned channel (pan/drive set)
  When drum.t4.model is set to Conga
  Then the old voice's output is disconnected, a Conga instance is wired into the
       same channel, cached tune/decay are replayed, and pan/drive are unchanged
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: Old songs keep the classic voices (REQ-11, no-op default)
  Given a song file that never mentions drum.t{i}.model
  When it is applied
  Then every track's model equals its own index (the classic voice)
# pinned by: tests/state/params.test.ts

Scenario: A hit disconnects its one-shot nodes once it ends (REQ-9, regression)
  Given a drum voice is triggered
  When the hit's source(s) finish (onended fires; the last one for a multi-source voice)
  Then every per-hit node it created is disconnected, including the choke gain when choked
  And the persistent per-synth output gain is never disconnected
# pinned by: tests/audio/drums/drum-synths.test.ts

Scenario: Step clicks don't rebuild the tuning strip or leak listeners (REQ-10, regression)
  Given the drum tuning strip shows track T's knobs
  When the user clicks steps within track T repeatedly
  Then the tuning knobs are not rebuilt (a rebuild happens only when the selected track changes)
  And a destroyed Knob has removed every window pointer listener it added
# pinned by: tests/ui/knob.test.ts
Scenario: A closed hat cuts the open hat once choke is on (v6, REQ-12)
  Given drum.choke is on, with a C.Hat and an O.Hat track
  When the closed hat fires
  Then the open hat's choke gain ramps to 0 and is restored straight after
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: Choke is off by default, so no shipped song changes (v6, REQ-12, ADR-006)
  Given drum.choke at its default 0
  When a closed hat fires over a ringing open hat
  Then nothing is choked
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: The group follows the voice model, not the track (v6, REQ-12)
  Given the O.Hat model has been moved onto another track
  When a closed hat fires
  Then the relocated open hat is choked and the vacated slot is not
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A ratcheted closed hat chokes on every sub-hit (v6, REQ-12, edge)
  Given a closed-hat step with ratchet 3 and choke on
  Then the open hat is cut three times, at each sub-hit's own time
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A hit is reported with its track, scheduled time and velocity (v7, REQ-13)
  Given a listener registered through onHit
  When an active cell plays
  Then it receives the track index, the absolute time the hit sounds and the cell velocity
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A ratcheted step reports one hit per sub-hit (v7, REQ-13)
  Given a step with ratchet 4
  When it plays
  Then onHit fires four times, at four distinct ascending times
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A hit that does not sound is not reported (v7, REQ-13, edge)
  Given a step on a muted track, or one whose probability roll fails,
        or a machine that is disabled
  When the tick is swept
  Then onHit does not fire
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A lane mute stops the reports too (v8, REQ-13, regression)
  Given an active drum pattern being reported through onHit
  When the drum LANE is muted, silencing the bus without stopping the pattern
  Then onHit stops firing, so a trigger-keyed effect stops pumping
   And it resumes on un-mute
# pinned by: tests/audio/transport/drum-machine.test.ts, tests/audio/lane-mixer.test.ts

Scenario: Soloing another lane stops them as well (v8, REQ-13, regression)
  Given an active drum pattern being reported through onHit
  When the sequencer lane is soloed, so the drum bus is silenced
  Then onHit stops firing, because audibility — not the mute flag — is the rule
# pinned by: tests/audio/lane-mixer.test.ts

Scenario: A manual audition is reported too (v7, REQ-13)
  Given a listener registered through onHit
  When triggerTrack auditions a pad
  Then onHit fires at the current time, so an auditioned drum drives a ducker
# pinned by: tests/audio/transport/drum-machine.test.ts
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
- Per-track voice models shipped in v5 (REQ-11) with five percussion voices;
  further models (e.g. 808 vs 909 kick variants) can extend
  `DRUM_MODEL_LABELS` without another schema change.
```
