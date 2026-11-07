# Oscillator sync (hard + soft sync)

```yaml
id: oscillator-sync
status: implemented
version: 9
owner: core
related:
  - oscillators                # osc1/osc2 this pairs up
  - mod-matrix                 # the `sync` destination
  - lfo                        # the `sync` destination
  - voicing                    # unison/drift/glide reach the pair through the voice
  - runtime-performance        # the pair is created on first use
  - ../decisions/adr-026-oscillator-sync-is-a-per-voice-worklet-pair
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-012-true-bypass-disconnects
  - ../decisions/adr-017-modulation-in-graph
  - cross-modulation           # ring mod reads the pair's outputs, FM drives its slave
source:
  - public/worklets/sync-osc.js      # the DSP
  - src/audio/sync-osc/node.ts       # the wrapper
  - src/audio/sync-osc/engagement.ts # native <-> pair crossfade + idle gate (SyncEngagement)
  - src/audio/frequency-line.ts      # the glide maths Osc and the pair share
  - src/audio/oscillator.ts          # native fade + the mirror the pair follows
  - src/audio/voice.ts               # engage/disengage, the pitch + sync junctions
  - src/audio/engine.ts              # lazy creation, subscriptions
  - src/audio/lfo.ts                 # toSync
  - src/state/lfo-routing.ts         # LFO_DEST_SCALE
  - src/audio/mod-matrix.ts          # the sync destination
  - src/state/params.ts              # osc2.sync, osc2.syncPitch, LFO_DEST_LABELS
  - src/state/mod-routing.ts         # MOD_DEST_LABELS
  - src/state/mod-depth.ts           # the SYNC knob's reach arc
  - src/ui/panels/synth-panels.ts    # SYNC segmented + knob on OSC 2
  - public/sw.js                     # the worklet is precached in CORE_ASSETS
```

Oscillator sync locks osc2 (the **slave**) to osc1 (the **master**). Each time the
master completes a cycle, the slave is reset (**hard**), or reset with every edge
rounded (**soft**). The slave's pitch becomes timbre, and sweeping it gives the
classic tearing sync lead.

## Background / Why

A native `OscillatorNode` cannot reset its phase. [ADR-026](../decisions/adr-026-oscillator-sync-is-a-per-voice-worklet-pair.md)
records the choice: a per-voice worklet that renders both oscillators while sync is
engaged, with every discontinuity band-limited, and nothing while it is not. The
ADR holds the band-limiting comparison. In short, a precomputed bank cannot sweep,
a naive reset aliases at −3…−24 dB and polyBLEP at −16…−39 dB, while the
windowed-sinc residual reaches the floor in band.

## Requirements

- **REQ-sync-off-is-the-native-path** — `osc2.sync` defaults to `off`. While off,
  the native oscillators feed the mixer through `Osc`'s unity fade gain, the
  worklet is absent or disconnected and idle, and nothing existing sounds
  different (ADR-006).
- **REQ-sync-has-hard-and-soft-modes** — `osc2.sync` is discrete `off | hard |
  soft`. **hard** resets the slave to the start of its cycle at the master's wrap.
  **soft** resets it the same way and rounds every slave edge
  (REQ-soft-sync-rounds-every-slave-edge). Reversing, threshold, phase-advance,
  inhibit and overlap variants are out of scope; reversing was rejected by ear (a
  sub-octave hum at SYNC 0).
- **REQ-soft-sync-rounds-every-slave-edge** — In soft mode **each** value jump
  (the slave's own wraps and pulse edges, as well as the resets) glides along a
  raised cosine over `SOFT_ROUND = 0.2` of the slave's period. Rounding only the
  resets left the slave's own wraps standing out as an extra note on each SYNC
  change. The width follows the slave's pitch **before FM** and never exceeds
  `SOFT_ROUND` of the master's period, so glides cannot pile up when FM stalls the
  slave. At SYNC 0, soft is a rounded saw, not plain OSC 2.
- **REQ-sync-pitch-is-the-sweep** — `osc2.syncPitch` (`0..48` st) sets the slave's
  pitch **above** osc2's own octave + tune. It is inert while sync is off. Its
  default is `12`, so engaging is audible straight away (an inert param's default
  is still a no-op).
- **REQ-the-pair-owns-both-phases** — While engaged, one worklet per voice renders
  **both** osc1 (output 0) and osc2 (output 1). The worklet cannot read a native
  node's phase, and two pitch computations would drift and comb-cancel at ratio 1.
  One owner makes the lock structural.
- **REQ-the-pair-follows-every-osc-control** — Wave, octave, tune and pulse width
  (including a live PWM sweep) reach the pair through a mirror on each `Osc`. Its
  outputs land on each `Osc.signal`, the pre-level tap the native fade feeds too,
  so level stays on `Osc.out` ([cross-modulation](cross-modulation.md)
  REQ-oscillator-signals-are-tapped-pre-level). Glide uses the native maths
  (`FrequencyLine`). A pair attached mid-note follows the master's scheduled curve
  (`FrequencyLine.follow`), so a glide in flight finishes and a lookahead note
  lands on time. The sub-oscillator stays native and unsynced.
- **REQ-every-pitch-source-reaches-the-pair** — Pitch bend, the per-note bend, both
  LFOs' `pitch`, drift and matrix `pitch` routes connect to `pitchTargets()`: the
  three native detunes plus one pitch junction feeding the pair, written once. The
  pair's `detune` spans **±24000 ¢**, beyond the ±18000 ¢ the sources can sum
  (both LFOs at `LFO_DEST_SCALE.pitch`, every matrix row at `MOD_DEST_SCALE[pitch]`,
  `BEND_MAX`). So no clamp makes the pair disagree with the native detunes.
- **REQ-sync-is-a-modulation-destination** — `sync` is appended to
  `MOD_DEST_LABELS` (±48 st) and `LFO_DEST_LABELS` (±24 st). Both sum into a
  per-voice sync junction whose offset is the knob, so per-voice sources work
  in-graph (ADR-017); the filter envelope sweeping sync is the archetypal patch.
  The SYNC knob draws its reach arc ([mod-matrix](mod-matrix.md)
  REQ-a-modulated-knob-shows-its-reach).
- **REQ-engaging-sync-crossfades** — Engaging or disengaging crossfades native and
  pair with complementary `RAMP_BYPASS` ramps, then **disconnects** the silent side
  (ADR-012). Blink then skips the cut source. Gecko still renders a started node
  it holds ([cross-modulation](cross-modulation.md)
  REQ-cross-mod-disconnects-when-unused), so there the saving is downstream only.
  A toggle inside the window supersedes the earlier one. Engaging adds no click
  (rendered on both engines).
- **REQ-the-pair-is-built-on-first-use** — No module is loaded and no pair exists
  until `osc2.sync` first leaves `off` ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request). Until then, voices play native. A failed load
  is logged (never thrown into a subscriber) and **forgotten**, so the next switch-on
  retries (the shared `loadWorkletModule`). Only the load retries: once the module
  is in, the pairs are built once, since attaching twice would double modulation.
  The worklet is in `CORE_ASSETS`, so an installed app can engage offline. The
  thin wrapper is a static import on purpose: a hashed lazy chunk an offline
  session never fetched would be a second way to fail.
- **REQ-the-pair-idles-with-the-voice** — An engaged pair follows the voice like
  the filter ([ladder-filter](ladder-filter.md) REQ-the-filter-idles-when-gated):
  active from `noteOn`, inactive once idle. It is the same scheduled `active`
  param ([ladder-filter](ladder-filter.md) REQ-the-gate-is-scheduled-not-messaged),
  so an engaged pair is awake by the block its note's attack opens in. Engaging
  sets the gate from whether the voice sounds **now**.
- **REQ-every-discontinuity-is-band-limited** — Each value jump (saw/square edges,
  hard resets, wave/width changes) gets a band-limited step residual, each slope
  jump a band-limited ramp, and a sine reset's curvature jump a third-order
  residual, all at the event's sub-sample time. A soft glide's end curvature
  jumps get the third-order residual. Below 12 samples (a slave above ~800 Hz at
  48 kHz) a glide hands its jump back to the step residual, fully by 4 samples. The
  kernel is a Blackman-Harris-windowed sinc, half-length `16`, cutoff `0.42·fs`,
  integrated once per module. Its lookahead delays **both** outputs by the same 16
  samples (0.33 ms at 48 kHz).
- **REQ-the-reset-keeps-the-overshoot** — A hard reset puts the slave where it
  would be had it started at the master's exact wrap (`overshoot × slave
  increment`), not at 0. Otherwise the cycle jitters by up to a sample.
- **REQ-the-slave-is-dc-free** — The slave passes a 5 Hz DC blocker, and a pulse's
  analytic mean (`2w−1`) is subtracted from both oscillators, so a sweep pushes no
  sub-audio wobble into the filter and the engage crossfade does not thump. The
  blocker's state is flushed to 0 below 1e-20 at block end, so a quiet pair does
  not decay through the subnormal range.
- **REQ-the-pair-is-bounded** — Output is finite and within **±4** for any
  parameter, NaN and Infinity included. Every increment is clamped to `[0, 0.45]`
  cycles per sample. The sync offset is clamped to `[-24, 72]` st. Both outputs are
  clamped to ±4, and a block ending non-finite resets the pair to silence (ADR-010
  *stable*). A narrow pulse with ringing reaches ~2.25 in every mode, and soft sync
  under extreme FM ~3.4.

## Technical design

### Data shapes (registry)

```yaml
osc2.sync:      { discrete, labels: OSC_SYNC_LABELS, range: 0..2, default: 0 }    # off | hard | soft
osc2.syncPitch: { range: 0..48, default: 12, unit: st }                           # inert while sync is off
MOD_DEST_LABELS: [..., 'sync']        # append-only (mod-matrix REQ-label-arrays-are-append-only), scale 48 st
LFO_DEST_LABELS: [..., 'sync']        # append-only (lfo REQ-destination-is-one-of-the-labels), ±24 st = LFO_DEST_SCALE.sync
```

### Contract / public interface

```yaml
SyncOscNode (src/audio/sync-osc/node.ts):
  static loadModule(ctx)          # '/worklets/sync-osc.js', once, on first engagement
  static create(ctx)              # one per voice
  master / slave: GainNode        # the two outputs' fade gains, 0 until engaged
  freq: FrequencyLine             # drives the a-rate `frequency` param (Hz)
  detune, syncPitch: AudioParam   # a-rate (cents, semitones), fed by the voice's junctions
  fm: AudioParam                  # a-rate FM index β (cross-modulation.md REQ-fm-reaches-the-sync-pair)
  setMode(m)                      # k-rate `mode`: 0 free (tests), 1 hard, 2 soft
  masterMirror, slaveMirror       # OscMirror -> wave1/2, masterCents/slaveCents, width1/2 (k-rate)
  setActive(on)                   # the idle gate
SyncEngagement (src/audio/sync-osc/engagement.ts):  # one per voice; owns the state machine
  attach(pair)                    # once: mirrors on, the master's curve followed, stored mode applied
  setMode(m)                      # stored before a pair exists; engage/disengage crossfade
  setFrequency(hz, when, glide)   # every note, engaged or not
  setVoiceActive(on)              # idle gate, only while engaged
  # one pending disconnect at a time: a toggle inside the window clears it
FrequencyLine (src/audio/frequency-line.ts):
  set(hz, when, glideSec)         # the anchored-cancel glide Osc already used
  at(t)                           # closed-form value of the curve at t
Osc:
  setMirror(m | null)             # pushes current wave/cents/width at once, then every change
  fadeNative(on) / dropNative()
  frequencyAt(t)
Voice:                            # owns the junctions; delegates engagement to SyncEngagement
  pitchTargets(): AudioParam[]
  syncTarget: AudioParam          # the sync junction's offset
  attachSync(node)                # plugs the junctions in, then SyncEngagement.attach
  setSyncMode(m) / setSyncPitch(st)
LFO_DEST_SCALE (src/state/lfo-routing.ts):
  sync: 24                        # read by LFO.update AND mod-depth's arc
```

### Worklet message contract

```yaml
port in:  none                    # the idle gate is the k-rate `active` param, default 1
port out: none
processorOptions:                 # measurement hooks for the alias test; the node never passes them
  kernel: 'sinc' | 'poly' | 'naive'
  half: 1..31                     # sinc half-length
outputs: 2, mono each             # 0 = master (osc1), 1 = slave (osc2)
```

### Layer touchpoints & ordering

```yaml
registry: src/state/params.ts -> osc2.sync, osc2.syncPitch, LFO_DEST_LABELS += sync
routing:  src/state/mod-routing.ts -> MOD_DEST_LABELS += sync, MOD_DEST_SCALE[sync] = 48
engine:   osc2.sync      -> ensureSync() (lazy, memoized) then all(v.setSyncMode)
          osc2.syncPitch -> all(v.setSyncPitch)
graph (per voice, engaged):
  pitch sources -> pitchTargets() = [osc1.detune, osc2.detune, sub.detune, pitchMod.offset]
  pitchMod -> pair.detune ; syncMod(offset = knob) -> pair.syncPitch
  lfo.toSync, matrix sync routes -> syncMod.offset
  pair out0 -> master gain -> osc1.signal ; pair out1 -> slave gain -> osc2.signal
  native osc1/osc2 -> Osc.fade -> Osc.signal   (faded out, then disconnected)
  Osc.signal -> Osc.out (level)
  fmMod (cross-mod's index junction) -> pair.fm
ui: OSC 2 panel — SYNC segmented (off/hard/soft) + SYNC knob (shown while sync != off)
```

The junctions are `ConstantSourceNode`s (offset 0 for pitch, the knob for sync),
so every target stays an `AudioParam`. The pitch junction is an *additional*
destination of each source, which is why sync-off renders exactly as before. A new
pitch source connects to **every** `pitchTargets()` entry, never to a hand-listed
set (ADR-026).

## Scenarios (BDD)

```gherkin
Scenario: Sync off is the native path (REQ-sync-off-is-the-native-path, backward compat)
  Given a preset that never set osc2.sync
  Then osc2.sync is off and no sync worklet module has been loaded
  And the native oscillators feed the mixer as before
# pinned by: tests/audio/voice-sync.test.ts, tests/state/params.test.ts

Scenario: Engaging sync builds the pairs once, on first use (REQ-the-pair-is-built-on-first-use)
  Given the engine has booted with sync off
  When osc2.sync becomes hard, then off, then soft
  Then the worklet module is loaded exactly once and one pair exists per voice
# pinned by: tests/audio/engine-sync.test.ts

Scenario: A failed load is retried on the next switch-on (regression, REQ-the-pair-is-built-on-first-use)
  Given the sync worklet fails to load once
  When osc2.sync leaves off
  Then a warning is logged, nothing throws and the voices play native
  When osc2.sync leaves off again
  Then the module loads and one pair is attached per voice
# pinned by: tests/audio/engine-sync.test.ts

Scenario: Engaging crossfades native to pair, then cuts the native side (REQ-engaging-sync-crossfades)
  Given a voice with its pair attached
  When sync is set to hard
  Then the pair's gains ramp to 1 and the native fades ramp to 0
  And after the crossfade the native oscillators are disconnected
  When sync is set back to off within the crossfade window
  Then the native side is not disconnected and the pair is cut instead
# pinned by: tests/audio/voice-sync.test.ts

Scenario: The pair follows the OSC panels (REQ-the-pair-follows-every-osc-control)
  Given a voice with its pair attached
  When osc1's wave, octave or width changes, or osc2's tune changes
  Then the pair's matching param is written
# pinned by: tests/audio/voice-sync.test.ts

Scenario: Every pitch source reaches the pair (REQ-every-pitch-source-reaches-the-pair)
  Given the engine is running
  Then pitch bend, both LFOs' pitch, drift and the per-note bend connect to each voice's pitch junction
  And a matrix pitch route wires the junction along with the three detunes
# pinned by: tests/audio/engine-sync.test.ts, tests/audio/voice-sync.test.ts, tests/audio/mod-matrix.test.ts

Scenario: The pair's pitch range covers every source summed (regression, REQ-every-pitch-source-reaches-the-pair)
  Given both LFOs, every matrix row and a step bend at full pitch depth
  Then their sum lies inside the pair's `detune` range
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: Sync is a modulation destination (REQ-sync-is-a-modulation-destination)
  Given mod row 0 routes filter env to sync at amount 0.5
  Then each voice's sync junction receives the route at 24 semitones
  And the SYNC knob's reach is 24 semitones
  And an LFO on sync drives its toSync output at ±24 semitones
# pinned by: tests/audio/mod-matrix.test.ts, tests/state/mod-depth.test.ts, tests/audio/engine-sync.test.ts

Scenario: Hard sync locks the slave to the master's period (REQ-sync-has-hard-and-soft-modes)
  Given the pair in hard mode at a non-integer ratio
  Then the slave output repeats with the master's period
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: A wrap that lands exactly on a sample still resets (regression, REQ-sync-has-hard-and-soft-modes)
  Given a master period of a whole number of samples
  Then every master wrap resets the slave
# pinned by: tests/audio/sync-osc-worklet.test.ts (the 64-sample period case)

Scenario: Soft sync rounds every slave edge (REQ-soft-sync-rounds-every-slave-edge)
  Given the pair in soft mode with a saw slave at ratios 1.5 to 4.3
  Then no sample-to-sample step exceeds the steepest glide's (π/w of a 2-unit jump)
  And the same patch in hard mode does jump
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: Soft sync stays locked to the master (REQ-sync-has-hard-and-soft-modes)
  Given the pair in soft mode at a non-integer ratio
  Then the slave output repeats with the master's period
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: An FM-stalled slave does not pile its glides up (regression, REQ-soft-sync-rounds-every-slave-edge)
  Given the pair in soft mode on a 20 kHz master, SYNC -24 st, a triangle slave and FM 4
  Then every output sample stays within ±4, and within ±3.5 for any FM up to 16
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: Sync aliasing is at the floor in band (REQ-every-discontinuity-is-band-limited)
  Given a saw slave hard- or soft-synced at ratios 1.5 to 7.9 on masters from 130 Hz to 2.9 kHz
  Then energy between the harmonics is at least 60 dB down below 10 kHz
  And for hard sync the shipped kernel beats polyBLEP and a naive reset by at least 15 dB in every case
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: The pair is bounded for any input (REQ-the-pair-is-bounded, edge)
  Given NaN, Infinity, 0 Hz and extreme sync offsets on every param
  Then every output sample is finite and within ±4
# pinned by: tests/audio/sync-osc-worklet.test.ts

Scenario: The pair idles with the voice (REQ-the-pair-idles-with-the-voice)
  Given sync is engaged
  When a note starts and later releases to idle
  Then the pair is told active at noteOn and inactive once the voice is idle
# pinned by: tests/audio/voice-sync.test.ts

Scenario: Re-engaging after the voice idled leaves the pair idle (regression, REQ-the-pair-idles-with-the-voice)
  Given sync is engaged over a held note
  When sync is turned off, the voice goes idle inside the crossfade window, and sync is turned back on
  Then the pair is told inactive
# pinned by: tests/audio/voice-sync.test.ts

Scenario: Attaching mid-glide finishes the glide (regression, REQ-the-pair-follows-every-osc-control)
  Given glide is on and a glide from A4 to A5 is in flight
  When the pair is attached
  Then the pair starts where the curve has reached and glides on to A5 with the same time constant
  And a note scheduled ahead of now still starts at its own time on the pair
# pinned by: tests/audio/voice-sync.test.ts

Scenario: The SYNC knob is only on show while sync is engaged
  Given osc2.sync is off
  Then knob-osc2.syncPitch is hidden
  When the user selects hard
  Then it appears
# pinned by: e2e/controls.spec.ts
```

## Tests & verification

- Unit: `tests/audio/sync-osc-worklet.test.ts` (the DSP under stubbed worklet
  globals, like `ladder-filter-worklet.test.ts`), `tests/audio/voice-sync.test.ts`,
  `tests/audio/engine-sync.test.ts`, and the `mod-matrix` / `mod-depth` / `params`
  suites — `npm test`. E2E: `e2e/controls.spec.ts`.
- **The alias metric** is objective: a hard-synced wave is exactly periodic at the
  master's frequency. With a half-integer period in samples, every folded partial
  lands *between* the harmonics, where the DFT bins measure it directly. A **sine
  slave** degrades above ~3 kHz masters (higher-order jumps that only oversampling
  would fix). That is accepted under ADR-010.
- **Cost** (Node, 8 sounding voices): ~3.5–12 % of one core, against the ladder
  filter's ~3.4 %. The pair runs only for sounding voices with sync on.
- **By ear** (ADR-010, `recipes/verify-audio-by-ear.md`): `npm run bench:audio` on
  Chromium **and** `--browser firefox` (the pair is driven by automation), A/B
  against sync-off with the drums muted.

## Open questions / future

- **The engage step is level-matched on Blink, not Gecko.** Gecko's native
  oscillators render quieter (sync-off RMS 0.0160 against 0.0248), while the pair is
  the same on both. So on Firefox engaging is ~4 dB louder. The gap is in the native
  path. Settle it by ear before compensating either side.
- Threshold ("weak") sync is the cheapest next mode: the same DSP behind a gate.
- FM inside the pair is not through-zero yet ([cross-modulation](cross-modulation.md)).
- The sub-oscillator could join the pair as a third phase if a locked sub matters
  by ear.
