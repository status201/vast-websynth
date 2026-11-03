# LFO & mod wheel

```yaml
id: lfo
status: implemented
version: 14
owner: core
related:
  - architecture
  - ladder-filter
  - filter-models        # owns the `shape` destination's target param
  - envelopes
  - effects              # the pan node sits at the end of the synth insert chain
  - render-to-sampler    # the bank-render tap reads the panner
  - oscillators          # owns pulse width; the `pulse` destination drives it
  - panel-tabs           # hosts the LFO 1 / LFO 2 pages
  - dropdown
  - mod-matrix           # the LFOs are its rows 0-1
  - tempo-lock           # owns the rate lock's control, shared with the effects
source:
  - src/audio/lfo.ts
  - src/audio/pwm.ts
  - src/state/params.ts
  - src/audio/engine.ts    # panner construction + LFO fan-out
  - src/audio/stereo.ts    # forceStereo
  - src/state/lfo-routing.ts   # the two-LFO vocabulary + LFO_DEST_SCALE
  - src/ui/panels/lfo-panel.ts # the two-page panel
```

**Two** global low-frequency oscillators, each with a selectable destination, plus
a mod wheel that adds into the first one's depth. Further routing (many
destinations per source, per-route depth) is the [mod matrix](mod-matrix.md).

## Background / Why

An LFO provides cyclic modulation (vibrato, tremolo, filter wobble). Each is a
single engine-level node (not per-voice). The **mod wheel** sums into LFO 1's
amount so a performance gesture brings modulation in on top of the patched base,
clamped to `[0, 1]`. A second, identical LFO (`lfo2.*`, off by default) lets a
patch have a filter sweep *and* a vibrato.

## Requirements

- **REQ-each-lfo-has-four-controls** — Each LFO has rate / amount / waveform /
  destination, plus the tempo lock `sync` (REQ-lfo-sync-locks-rate-to-tempo):
  five params per LFO.
- **REQ-mod-wheel-sums-into-lfo-one** — LFO 1's effective amount = `min(1,
  lfo.amount + master.modWheel)`; **both** inputs recompute it. LFO 2's is
  `lfo2.amount` alone (REQ-the-mod-wheel-feeds-lfo-one-only).
- **REQ-destination-is-one-of-the-labels** — Destination is one of the
  `LFO_DEST_LABELS` (range `0..7`). Labels are **append-only**: an index is a
  stored value in every preset, song and share link.
- **REQ-pan-sweeps-a-stereo-panner** — (v2) The `pan` destination sweeps one
  `StereoPannerNode` (`synthPan`) on the **synth bus**, after the insert chain and
  before `preMaster`. `pan` clamps to `±1` by construction, so the destination is
  bounded for any amount. The LFO is global, so a bus panner sounds identical to
  per-voice panners, and it is one node instead of eight. It also keeps the head of
  the insert chain 1-channel (ADR-010; where the chain turns 2-channel is
  [effects](effects.md) REQ-the-synth-chain-order).
- **REQ-the-auto-pan-reads-a-stereo-input** — (v11) **`synthPan`'s input is forced
  to two channels.** A `StereoPannerNode` passes stereo through at centre but
  applies the equal-power law to **mono**, which is 3.01 dB down. So whether
  anything upstream happened to be 2-channel decided the whole channel's level.
  `forceStereo` (`src/audio/stereo.ts`) pins `channelCount 2`, `'explicit'`,
  `'speakers'`, so mono up-mixes to `L = R = x` at unity. That is what lets
  per-track pan splice in and out without the level moving
  ([sequencer](sequencer.md) REQ-the-spread-stage-engages-off-centre, ADR-023). The
  sampler's per-slot pan uses the same helper ([sampler](sampler.md)
  REQ-each-slot-has-a-channel).
- **REQ-amplitude-destinations-are-smoothed** — (v2) `amp`, `pan` and `shape`
  (REQ-shape-destination-sweeps-the-pole-mix) are fed through a shared lowpass
  (200 Hz, linear `Q = 0.5`, critically damped), built by `createControlSmoother`.
  That turns a square/saw jump into a ~3 ms slew with no overshoot instead of a
  click. Web Audio reads a lowpass `Q` in **dB**, so the value written is
  `SMOOTH_Q_DB` = 20·log10(0.5) ≈ −6.02; a bare `0.5` is linear Q ≈ 1.06, which
  overshoots a step by ~19%. `pitch`, `cutoff` and `sync` are fed raw: a
  stepped octave is a musical event. Each LFO owns its own smoothing filter.
  `modTap`, the unit-amplitude output the [mod matrix](mod-matrix.md) reads, is
  also on the smoothed path, since a route may land on any destination. That is
  inaudible at LFO rates (−0.09 dB at 20 Hz).
- **REQ-pulse-destination-sweeps-width** — (v3) `pulse` sweeps oscillator pulse
  width. It is the one destination with **no audio-node output**: a native
  `OscillatorNode` has no width `AudioParam`, so `PwmDriver` drives it from a
  JS-side mirror of the LFO shape. Contract, rate cap and cost live in
  [oscillators](oscillators.md) REQ-width-swaps-a-precomputed-wave through
  oscillators.md REQ-a-background-tab-throttles-pwm. One LFO holds one
  destination, so its mirror and its own oscillator are never both in use.
- **REQ-shape-destination-sweeps-the-pole-mix** — (v4) `shape` sweeps the POLY
  filter's pole-mix morph `filter.shape` by `±0.5` around the knob
  ([filter-models.md](filter-models.md)
  REQ-shape-morphs-the-pole-mix/REQ-shape-is-an-lfo-destination). It moves
  coefficients, so it is smoothed like `amp`. It is a no-op under LADDER
  (filter-models REQ-shape-is-poly-only).
- **REQ-lfo-rate-is-exponentially-tapered** — (v5) `lfo.rate` has an `exp` taper
  over `0.05..20` Hz. Rate is heard in octaves, so equal turns are equal ratios and
  the knob's midpoint is 1 Hz. Stored values are Hz and unchanged. Motion anchors
  are stored in taper space, so a lane on `lfo.rate` resolves differently than
  under a linear taper. That was accepted rather than migrated: no demo assigns it.
- **REQ-lfo-sync-locks-rate-to-tempo** — (v6) `lfo.sync` index 0 is `free`, which
  is the default and an exact no-op. The rest are the note divisions from
  `utils/tempo.ts`. While synced, the rate is `1 / (beats * 60 / bpm)`,
  recomputed on every `transport.bpm` change, so it follows a ramp or a MIDI clock.
  `lfo.rate` is **not rewritten**; it is what the knob returns to on `free`. The
  control is the knob's own note glyph, and the chosen division replaces the dial
  ([tempo-lock](tempo-lock.md)
  REQ-the-lock-is-a-note-glyph/REQ-locked-the-division-replaces-the-dial). The
  divisions are the table the tempo-sync help badges recommend from. `pwm.setRate`
  follows the effective rate of whichever LFO owns the driver
  (REQ-pulse-is-arbitrated).
- **REQ-there-are-two-lfos** — (v7) `lfo.*` and `lfo2.*` are identical except for
  REQ-the-mod-wheel-feeds-lfo-one-only. Both come from **one
  `lfoParams(prefix)` factory**, so they cannot drift apart. They reuse
  `WAVE_LABELS`, `LFO_DEST_LABELS` and `SYNC_LABELS`, and `syncParam(prefix)` is
  the same def the effects use ([tempo-lock](tempo-lock.md)
  REQ-sync-defaults-to-free). `lfo2.dest` defaults to `off` **and** `lfo2.amount`
  to `0`, a double no-op (ADR-006). Additive scalars need no song-format bump
  (ADR-007).
- **REQ-the-mod-wheel-feeds-lfo-one-only** — (v7) `master.modWheel` sums into
  `lfo.amount` only. The wheel has one classic meaning, bringing in the vibrato,
  and opening a second modulation too would be one gesture with two outcomes
  (ADR-014 law 2). LFO 2 is the patched modulator; LFO 1 is the played one.
- **REQ-destinations-are-no-longer-exclusive** — (v7) The two LFOs may hold the
  same destination, and it sums
  (REQ-duplicated-destinations-sum-and-stay-bounded;
  [mod-matrix](mod-matrix.md) REQ-two-rows-may-share-a-destination). The validators
  always accepted both `dest` params independently, so allowing it in the UI
  changes no saved sound. The only destination greying is the matrix's per-voice
  vs bus-wide rule ([mod-matrix](mod-matrix.md)
  REQ-per-voice-sources-cannot-drive-bus-destinations, in
  `src/state/mod-routing.ts`). It greys rather than removes, and the reason is
  readable without hover (ADR-014 law 6).
- **REQ-duplicated-destinations-sum-and-stay-bounded** — (v7) Every destination
  except `pulse` is a `GainNode` into a summing `AudioParam`, so both LFOs on one
  destination is well-defined: pitch `±2400` cents, cutoff `±48` semitones (still
  additive, ADR-005), shape `±1.0`, amp `0.0..2.0` around the VCA's base `1.0`
  (touches silence, never inverts), pan clamped to `±1`, sync `±48` semitones
  (the sync worklet clamps the total to `−24..72`, [oscillator-sync](oscillator-sync.md)).
- **REQ-pulse-is-arbitrated** — (v7) `pulse` is a parameter write, not a summed
  connection, so the one shared `PwmDriver` takes a **source index** and tracks an
  owner:
  - a source claims it on selecting `pulse` when it is unowned or owned by a
    **higher** index, and releases it on leaving. Setters from a non-owner are
    ignored;
  - **lowest index wins**, because `bus.restore()` iterates a snapshot in JSON
    insertion order, which a hand-authored file does not fix;
  - with both on `pulse`, LFO 2's selection is inert (all six of its output gains
    sit at `0`);
  - the owner check is what stops LFO 2 *leaving* `pulse` from stopping LFO 1's
    sweep.
- **REQ-the-two-lfos-share-one-panel** — (v7) The faceplate's eight columns are
  full, so LFO 2 is a second page of the LFO panel. The [panel-tabs](panel-tabs.md)
  strip **is** the header (`LFO 1` | `LFO 2`). Both pages stay mounted and
  subscribed. The selected page is session-only view state
  (panel-tabs.md REQ-selected-page-is-session-only). A tab carries a **lamp**
  whenever its LFO modulates (`dest !== off && amount > 0`), so a hidden LFO is
  never invisible state (ADR-014 law 5).

## Technical design

### Data shapes (registry)

Both LFOs register the same five params via `lfoParams(prefix)`, prefix in `lfo`, `lfo2`:

```yaml
<prefix>.rate:   { range: 0.05..20, default: 4, format: Hz, taper: exp }
<prefix>.amount: { range: 0..1, default: 0 }            # no-op default
<prefix>.wave:   { discrete, labels: WAVE_LABELS, range: 0..3, default: 0 }
<prefix>.dest:   { discrete, labels: LFO_DEST_LABELS, range: 0..7, default: 0 }
<prefix>.sync:   { discrete, labels: SYNC_LABELS, range: 0..18, default: 0 }
master.modWheel: { range: 0..1, default: 0 }            # sums into LFO 1 only
```

`LFO_DEST_LABELS = ['off', 'cutoff', 'pitch', 'amp', 'pulse', 'pan', 'shape', 'sync']`.
`sync` sums ±24 semitones at full amount into each voice's sync junction. It is
inert until oscillator sync is engaged ([oscillator-sync](oscillator-sync.md)
REQ-sync-is-a-modulation-destination), and raw like pitch. `SYNC_LABELS` is
`free` + 18 divisions from `utils/tempo.ts`.

### Contract / public interface

```yaml
LFO:                   # one instance per LFO
  toPitch:  GainNode   # cents      -> every pitchTargets() entry (raw)
  toCutoff: GainNode   # semitones  -> filter cutoffNote (raw)
  toAmp:    GainNode   # linear     -> tremolo gain (smoothed)
  toPan:    GainNode   # -1..1      -> synthPan.pan (smoothed)
  toShape:  GainNode   # -0.5..0.5  -> every voice's filter.shape (smoothed)
  toSync:   GainNode   # semitones  -> every voice's sync junction (raw)
  modTap:   AudioNode  # unit-amplitude smoothed output, read by the mod matrix
  setRate(hz) / setWave(idx) / setAmount(0..1) / setDest(idx)
  bind(bus, prefix, pulse, src, modWheelId?)   # self-wires its own params
# `pulse` has no output node — see PwmDriver (oscillators.md).
LFO_DEST_SCALE:        # src/state/lfo-routing.ts — full-scale depth per destination
  { pitch: 1200, cutoff: 24, amp: 0.5, pan: 1, shape: 0.5, sync: 24 }
  # read by LFO.update (the gains) AND mod-depth.ts (the knob arcs): one table
LfoPulseSink:          # the slice of PwmDriver an LFO may drive; structural,
  setDest(src, d)      #  so lfo.ts imports nothing from pwm.ts
  setRate(src, hz)
  setWave(src, idx)
  setAmount(src, a)
LFO_PREFIXES:  ['lfo', 'lfo2']   # src/state/lfo-routing.ts
```

`bind` follows ADR-008. Each LFO subscribes its own params, plus `transport.bpm`,
plus `modWheelId` when given (LFO 1 only). The rate/sync/BPM trio goes through
`bindTempoLocked` ([tempo-lock](tempo-lock.md)
REQ-audio-resolves-the-lock-in-one-place), and PWM rides the same callback. Only
the active destination's gain is non-zero; the rest ramp to `0`.

### Layer touchpoints

```yaml
engine (subscribeParams):
  this.lfo.bind(bus, 'lfo',  this.pwm, 0, 'master.modWheel')
  this.lfo2.bind(bus, 'lfo2', this.pwm, 1)   # no mod wheel
  osc{1,2}.pulseWidth -> this.pwm.setBase(i, x)   # stays in Engine: osc-owned
  # bind() runs after init(), which builds this.pwm
engine (construction):
  connectLfoToVoice(lfo, v)  # the per-voice connects, once per LFO per voice
  lfo.toPan, lfo2.toPan -> synthPan.pan      # two GainNodes, one AudioParam = sum
graph:
  per LFO:       osc -> toPitch, toCutoff, toSync                 # raw
                 osc -> smooth(lowpass 200Hz Q0.5) -> toAmp, toPan, toShape, modTap
  synth bus:     voiceBus -> synthFx -> synthPan -> preMaster
                 synthPan  -> bankRenderNode.input   # the render captures the pan
ui: src/ui/panels/lfo-panel.ts (both pages) + mod-wheel control
```

## Scenarios (BDD)

```gherkin
Scenario: The summed mod-wheel amount scales every destination's depth
  Given lfo.amount is 0.3 and master.modWheel is 0.5
  When the engine passes the sum 0.8 to the LFO
  Then the active destination's depth is 0.8 of its full-scale value
# pinned by: tests/audio/lfo.test.ts

Scenario: Amount is clamped at full (edge)
  Given a summed amount of 1.3 reaches the LFO
  Then the depth used is the full-scale value, not 1.3x it
# pinned by: tests/audio/lfo.test.ts

Scenario: The synth channel's level does not depend on the reverb (regression, REQ-the-auto-pan-reads-a-stereo-input)
  Given a held note with the synth reverb bypassed
  And the same held note with the reverb on and its mix at 0
  Then the two render at the same level, not 3.01 dB apart
# pinned by: tests/audio/engine-stereo.test.ts (channel config), and by ear per ADR-010

Scenario: Selecting pan drives the synth bus panner
  Given lfo.dest is set to "pan" and lfo.amount is 1
  Then toPan's gain ramps to 1 and toPitch/toCutoff/toAmp all ramp to 0
# pinned by: tests/audio/lfo.test.ts

Scenario: Switching away from pan re-centres the image
  Given lfo.dest is "pan"
  When the user selects "cutoff"
  Then toPan's gain ramps to 0, so pan settles at its 0 (centre) base value
# pinned by: tests/audio/lfo.test.ts

Scenario: Only the amplitude-domain destinations are smoothed (edge)
  Given the LFO waveform is square
  Then toAmp and toPan are fed through the smoothing lowpass
  And toPitch and toCutoff are fed from the oscillator directly
# pinned by: tests/audio/lfo.test.ts

Scenario: The smoother is critically damped in the unit Web Audio reads (regression)
  Given the LFO's smoothing lowpass
  Then its Q is written in dB, as SMOOTH_Q_DB
  And converted back to linear it is 0.5, so a step settles without overshoot
# pinned by: tests/audio/lfo.test.ts

Scenario: Selecting shape sweeps the POLY pole mix (REQ-shape-destination-sweeps-the-pole-mix)
  Given lfo.dest is set to "shape" and lfo.amount is 1
  Then toShape's gain ramps to 0.5 and every other destination gain ramps to 0
  And toShape is fed through the smoothing lowpass, not the raw oscillator
# pinned by: tests/audio/lfo.test.ts

Scenario: An existing patch's destination index is unchanged
  Given a preset saved with any "lfo.dest" in 0..4
  When it is loaded
  Then validation accepts it and index 3 is still "amp"
  And index 6 is now accepted, while 7 is still rejected
# pinned by: tests/state/preset-validate.test.ts

Scenario: The rate knob moves in octaves, not in Hz (REQ-lfo-rate-is-exponentially-tapered)
  Given lfo.rate is exponentially tapered over 0.05..20
  Then the knob's midpoint is 1 Hz, not 10 Hz
  And equal turns anywhere on the dial multiply the rate by the same factor
# pinned by: tests/state/params.test.ts

Scenario: An existing patch's stored rate survives the taper change (REQ-lfo-rate-is-exponentially-tapered)
  Given a preset with "lfo.rate" 12.5
  When it is loaded
  Then lfo.rate is still exactly 12.5 and validation accepts it
  And only the knob position it maps to has moved
# pinned by: tests/state/params.test.ts

Scenario: A synced LFO takes its rate from the tempo (REQ-lfo-sync-locks-rate-to-tempo)
  Given transport.bpm 120 and lfo.rate 7
  When lfo.sync is set to 1/4
  Then the LFO runs at 2 Hz, and at 1 Hz once the tempo halves
# pinned by: tests/ui/tempo-sync.test.ts, e2e/lfo-sync.spec.ts

Scenario: Free-running is the default and nothing changes (REQ-lfo-sync-locks-rate-to-tempo, ADR-006)
  Given lfo.sync is 0
  When the tempo changes
  Then the LFO keeps the rate the knob set
# pinned by: e2e/lfo-sync.spec.ts

Scenario: Leaving sync restores the knob's own rate (REQ-lfo-sync-locks-rate-to-tempo)
  Given a synced LFO whose stored lfo.rate is 7
  When lfo.sync goes back to free
  Then the LFO returns to 7 Hz — the stored value was never rewritten
# pinned by: e2e/lfo-sync.spec.ts

Scenario: The rate knob shows the division while synced (REQ-lfo-sync-locks-rate-to-tempo)
  When lfo.sync names a division
  Then knob-lfo.rate shows it on a chip in the dial's place, at 120 BPM reading
    "1/4" over a live "2.00Hz", and keeps its own stored value
# pinned by: tests/ui/lfo-panel.test.ts, e2e/lfo-sync.spec.ts

Scenario: There is no standalone sync picker
  Given the LFO panel
  Then neither page carries a sync dropdown of its own
  And each RATE knob carries a tempolock-<prefix>.rate button instead
# pinned by: tests/ui/lfo-panel.test.ts

Scenario: LFO 2 changes nothing until it is armed (REQ-there-are-two-lfos, ADR-006)
  Given a preset with no lfo2.* keys
  When it is loaded
  Then lfo2.dest is off and lfo2.amount is 0, and the patch sounds unchanged
# pinned by: tests/state/params.test.ts, e2e/lfo2.spec.ts

Scenario: The two LFOs are registered identically (REQ-there-are-two-lfos)
  Given both param sets come from one lfoParams(prefix) factory
  Then every lfo2.* def matches its lfo.* twin in min, max, default, taper and labels
# pinned by: tests/state/params.test.ts

Scenario: The mod wheel opens LFO 1 and leaves LFO 2 alone (REQ-the-mod-wheel-feeds-lfo-one-only)
  Given lfo.amount 0.3, lfo2.amount 0.4 and both destinations armed
  When master.modWheel moves to 0.5
  Then LFO 1's depth is 0.8 of full scale and LFO 2's is still 0.4
# pinned by: tests/audio/lfo.test.ts

Scenario: Both LFOs may hold one destination (REQ-destinations-are-no-longer-exclusive)
  Given lfo.dest is "cutoff"
  When the user opens LFO 2's destination list
  Then "cutoff" is selectable, not greyed
  And choosing it sums the two (REQ-duplicated-destinations-sum-and-stay-bounded)
# pinned by: tests/ui/lfo-panel.test.ts, e2e/lfo2.spec.ts

Scenario: A hand-authored duplicate loads and renders truthfully (edge)
  Given a song puts both LFOs on "amp"
  When the panel renders
  Then each dropdown shows "amp" as its own value, neither is blank
  And validation accepts the file
# pinned by: tests/ui/lfo-panel.test.ts, tests/state/preset-validate.test.ts

Scenario: Two LFOs on one destination sum, bounded (REQ-duplicated-destinations-sum-and-stay-bounded, edge)
  Given both LFOs are routed to "pan" at full amount
  Then both toPan gains reach 1 and the panner clamps the sum to +/-1
# pinned by: tests/audio/lfo.test.ts

Scenario: LFO 2 leaving a destination does not stop LFO 1's PWM sweep (REQ-pulse-is-arbitrated)
  Given LFO 1 owns the pulse driver and is sweeping the width
  When LFO 2 switches its destination from "off" to "cutoff"
  Then the driver keeps running and LFO 1's sweep is uninterrupted
# pinned by: tests/audio/pwm.test.ts

Scenario: The lower LFO index wins the pulse driver (REQ-pulse-is-arbitrated, edge)
  Given a hand-authored song sets both destinations to "pulse"
  When it loads in either key order
  Then LFO 1 drives the pulse width and LFO 2's setters are ignored
# pinned by: tests/audio/pwm.test.ts

Scenario: A modulating LFO on the hidden page lights its tab (REQ-the-two-lfos-share-one-panel)
  Given the panel is showing page 1 and lfo2.dest is "pan" at amount 0.6
  Then the LFO 2 tab is lit, and it goes dark when lfo2.amount returns to 0
# pinned by: tests/ui/lfo-panel.test.ts
```

## Tests & verification

- `tests/audio/lfo.test.ts`, `tests/audio/pwm.test.ts`, `tests/state/params.test.ts`,
  `tests/audio/mod-matrix.test.ts`, `tests/state/preset-validate.test.ts`,
  `tests/ui/lfo-panel.test.ts`, `e2e/lfo-sync.spec.ts`, `e2e/lfo2.spec.ts`,
  `e2e/controls.spec.ts` — `npm test` / `npm run e2e`.
- **By ear** (ADR-010, `recipes/verify-audio-by-ear.md`): the smoothing constants
  (square at full depth on `amp` and `pan`); both LFOs off against a baseline;
  LFO 1 → `pulse` while LFO 2 toggles away must not drop the sweep; both on `amp`
  at full depth must bottom out smoothly.

## Open questions / future

- The LFOs are global by design; a per-voice LFO would be a separate feature.
- **Two is a hard-coded count.** `LFO_PREFIXES`, `lfoParams`, `PwmDriver`'s owner
  arbitration and the two-tab panel assume exactly two. A third is: register
  `lfo3.*`, and it becomes another matrix source.
- `Engine` never calls `pwm.dispose()`. It is one shared driver, so one gap.
- Motion lanes and XY assignments store values **normalized 0..1**, so a lane
  targeting `lfo.dest` shifts meaning when the label range grows. Presets and songs
  store raw values. Accepted, since automating a discrete destination is not a
  supported gesture.
