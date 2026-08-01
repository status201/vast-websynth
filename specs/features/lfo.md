# LFO & mod wheel

```yaml
id: lfo
status: implemented
version: 4                  # v4: `shape` destination — v3: `pulse` implemented
owner: core
related:
  - architecture
  - ladder-filter
  - filter-models        # owns the `shape` destination's target param
  - envelopes
  - effects              # the pan node sits at the end of the synth insert chain
  - render-to-sampler    # the bank-render tap moved downstream of the panner
  - oscillators          # owns pulse width; the `pulse` destination drives it
source:
  - src/audio/lfo.ts
  - src/audio/pwm.ts       # the `pulse` destination's control loop (v3)
  - src/state/params.ts
  - src/audio/engine.ts    # panner construction + LFO fan-out
  - src/ui/app.ts
```

One global low-frequency oscillator with a selectable destination, plus a mod
wheel that adds into its depth.

## Background / Why

The LFO provides cyclic modulation (vibrato, tremolo, filter wobble). It is a
single engine-level node (not per-voice), routed to one destination at a time. The
**mod wheel** sums into the LFO amount so a performance gesture can bring modulation
in on top of the patched base amount — clamped to `[0, 1]` so it never overshoots.

## Requirements

- **REQ-1** — LFO has rate / amount / waveform / destination.
- **REQ-2** — Effective amount = `min(1, lfo.amount + master.modWheel)`; **both**
  `lfo.amount` and `master.modWheel` recompute it.
- **REQ-3** — Destination is one of the `LFO_DEST_LABELS` (range `0..6`, v4).
  Labels are **append-only**: an index is a stored value in every preset, song
  and share link, so reordering silently rewrites saved patches.
- **REQ-4** — (v2) The `pan` destination sweeps a single `StereoPannerNode` on
  the **synth bus**, placed after the insert chain and before `preMaster`. At
  full amount the sweep is hard L↔R; `StereoPannerNode.pan` clamps to `±1` by
  construction, so the destination is bounded for any amount. Because the LFO is
  global (one oscillator shared by all voices), a bus panner and a per-voice
  panner are audibly identical here — the bus node is chosen so the insert chain
  stays 1-channel (ADR-010, *cheap*; same reasoning as [ladder-filter](ladder-filter.md)
  REQ-9).
- **REQ-5** — (v2) The two **amplitude-domain** destinations (`amp`, `pan`) are
  fed through a shared one-pole-ish lowpass (`lowpass`, 200 Hz, `Q = 0.5` —
  critically damped, no overshoot), so a `square`/`saw` waveform's instantaneous
  jump becomes a ~2 ms slew instead of a click. The **frequency-domain**
  destinations (`pitch`, `cutoff`) are fed from the oscillator directly: a
  stepped octave or filter jump is a musical event, not a click. At LFO rates
  the smoothing is inaudible on shape (−0.02 dB, ~6° at 20 Hz).
- **REQ-6** — (v3) The `pulse` destination sweeps oscillator **pulse width**. It
  is the one destination with **no audio-node output**: a native
  `OscillatorNode` has no width `AudioParam`, so it is driven by `PwmDriver`
  from a JS-side mirror of the LFO shape rather than by a gain node. Its
  contract, rate cap and cost budget live in
  [oscillators](oscillators.md) REQ-6..REQ-10. Because destinations are
  exclusive, the JS mirror and the audio oscillator are never both in use, so
  they cannot drift against each other in any way a listener can hear.
- **REQ-7** — (v4) The `shape` destination sweeps the POLY filter's pole-mix
  morph, `filter.shape` ([filter-models.md](filter-models.md) REQ-6/11) — the LFO
  sweeps the filter's *type*, not just its cutoff. Depth is `±0.5` around the
  knob's position. Despite being frequency-domain in effect, it is fed from the
  **smoothed** path like `amp`/`pan`, not the raw path like `cutoff`: it moves
  filter *coefficients*, so a `square` waveform's instantaneous jump is a click,
  not a musical step. It is a no-op under the LADDER model, which ignores
  `filter.shape` (filter-models REQ-7).

## Technical design

### Data shapes (registry)

```yaml
lfo.rate:        { range: 0.05..20, default: 4, format: Hz }
lfo.amount:      { range: 0..1, default: 0 }            # no-op default
lfo.wave:        { discrete, labels: WAVE_LABELS, range: 0..3, default: 0 }
lfo.dest:        { discrete, labels: LFO_DEST_LABELS, range: 0..6, default: 0 }  # v4: +shape
master.modWheel: { range: 0..1, default: 0 }            # sums into lfo amount
```

`LFO_DEST_LABELS = ['off', 'cutoff', 'pitch', 'amp', 'pulse', 'pan', 'shape']`.
Index `0` stays `off`, so the default remains a no-op (ADR-006), and appending
keeps every value an existing patch can hold (`0..5`) at its original meaning.

### Contract / public interface

```yaml
LFO:
  toPitch:  GainNode   # cents      -> osc detune  (raw)
  toCutoff: GainNode   # semitones  -> filter cutoffNote (raw)
  toAmp:    GainNode   # linear     -> tremolo gain (smoothed)
  toPan:    GainNode   # -1..1      -> synth bus panner.pan (smoothed, v2)
  toShape:  GainNode   # -0.5..0.5  -> every voice's filter.shape (smoothed, v4)
  setRate(hz) / setWave(idx) / setAmount(0..1) / setDest(idx)
# `pulse` has no output node — see PwmDriver (oscillators.md).
```

Depth at full amount, per destination: pitch `±1200` cents, cutoff `±24`
semitones, amp `±0.5` linear (added to the tremolo VCA's base `1.0`), pan `±1.0`,
shape `±0.5` (v4). Only the active destination's gain is non-zero; the rest ramp
to `0`.

### Layer touchpoints

```yaml
engine (subscribeParams):
  updateLfoAmount = () => lfo.setAmount(min(1, get('lfo.amount') + get('master.modWheel')))
  lfo.rate           -> this.lfo.setRate(x)
  lfo.amount         -> updateLfoAmount()
  lfo.wave           -> this.lfo.setWave(x)
  lfo.dest           -> this.lfo.setDest(x)
  master.modWheel    -> updateLfoAmount()
  # v3: the same four params also feed PwmDriver, which owns the `pulse` path
  lfo.{rate,wave,dest} + the summed amount -> this.pwm.<setter>
  osc{1,2}.pulseWidth -> this.pwm.setBase(i, x)
graph (v2):
  lfo internal:  osc -> toPitch, toCutoff                    # raw
                 osc -> smooth(lowpass 200Hz Q0.5) -> toAmp, toPan
  synth bus:     voiceBus -> synthFx(dist..reverb) -> synthPan -> preMaster
                 lfo.toPan -> synthPan.pan
                 synthPan  -> bankRenderNode.input           # tap moved past the panner
ui: src/ui/app.ts (LFO panel) + mod-wheel control
```

When the destination is the filter, modulation is additive in **semitones** —
the same invariant as [ladder-filter](ladder-filter.md) and [envelopes](envelopes.md).

The bank-render tap (see [render-to-sampler](render-to-sampler.md)) reads from
the panner, not the FX tail, so a rendered bank captures the pan movement the
user heard.

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

Scenario: Selecting shape sweeps the POLY pole mix (v4)
  Given lfo.dest is set to "shape" and lfo.amount is 1
  Then toShape's gain ramps to 0.5 and every other destination gain ramps to 0
  And toShape is fed through the smoothing lowpass, not the raw oscillator
# pinned by: tests/audio/lfo.test.ts

Scenario: An existing patch's destination index is unchanged
  Given a preset saved before v2 with any "lfo.dest" in 0..4
  When it is loaded
  Then validation accepts it and index 3 is still "amp"
  And index 6 is now accepted, while 7 is still rejected
# pinned by: tests/state/preset-validate.test.ts
```

## Tests & verification

- `tests/audio/lfo.test.ts`, `tests/state/params.test.ts`,
  `tests/state/preset-validate.test.ts`, `e2e/controls.spec.ts`.
- `npm test` / `npm run e2e`.
- **By ear** (ADR-010, `recipes/verify-audio-by-ear.md`): the smoothing constants
  in REQ-5 are only settled by listening — square at full depth on both `amp` and
  `pan`, A/B'd against a bypassed baseline with the other lanes muted.

## Open questions / future

- The LFO is monophonic/global by design; a per-voice LFO would be a separate
  feature with its own params.
- **The engine-side mod-wheel sum is not unit-pinned.** `updateLfoAmount` is a
  closure inside the private `Engine.subscribeParams()`, unreachable from a test
  without a full `AudioContext` + worklet boot. `tests/audio/lfo.test.ts` pins
  the LFO's half (a summed amount scales depth, and is clamped at 1); the
  addition itself is covered only by inspection.
- `pulse` was a dead label until v3 — `update()` routed only pitch/cutoff/amp, so
  selecting it silenced all modulation while the UI advertised "PWM movement".
  Kept at index 4 rather than reclaimed, so no saved patch changed meaning.
- Motion lanes and XY assignments store values **normalized 0..1**, so a lane
  targeting `lfo.dest` shifts meaning when the range grows (`0.5` was `2`/pitch
  at `0..4`, is `3`/amp at `0..5`). Presets, songs and share links store raw
  values and are unaffected. Accepted rather than engineered around — automating
  a discrete destination is not a supported gesture.
