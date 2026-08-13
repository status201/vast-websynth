# Filter models

```yaml
id: filter-models
status: implemented
version: 1
owner: core
related:
  - ladder-filter
  - key-tracking
  - lfo
  - envelopes
  - presets
  - runtime-performance
  - ../decisions/adr-005-cutoff-as-midi-note
  - ../decisions/adr-006-no-op-param-defaults
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-016-one-filter-worklet-model-per-block
source:
  - public/worklets/ladder-filter.js      # both models (branch per block)
  - src/audio/ladder-filter/node.ts        # model + shape AudioParams
  - src/audio/voice.ts                     # per-voice setters
  - src/audio/lfo.ts                       # shape destination
  - src/audio/engine.ts                    # subscribeParams fan-out
  - src/state/params.ts                    # filter.model / filter.shape
  - src/state/preset.ts                    # factory presets carry both keys
  - src/ui/app.ts                          # FILTER panel model switch
```

The synth's filter is **selectable**: `LADDER` (index 0, the existing 4-pole
transistor ladder — [ladder-filter.md](ladder-filter.md)) or `POLY` (index 1, a
bass-preserving 4-pole multimode). This spec owns the *selector*, the POLY DSP
and the `SHAPE` pole-mix morph. Key tracking, which serves both models, is
[key-tracking.md](key-tracking.md).

## Background / Why

The ladder is the synth's character, but its topology forces two limits. It
**loses low end as resonance rises** — the feedback is subtracted from the input
(`v = x - res*fb`), so its DC gain is `1/(1+res)`, and `RES_MAKEUP` lifts the
whole response rather than restoring the body. And it is **low-pass only**: no
high-pass or band-pass exists anywhere in the voice path, so thin plucks, hollow
formant pads and notch-ish sweeps are unreachable.

POLY answers both from the *same* four-stage cascade, with three deliberate
divergences: the resonance compensation moves to the **loop input**, so the body
holds up instead of sagging as resonance rises (the Curtis/Prophet-600
behaviour); saturation moves out of the four stages into the **feedback path**
only (glassy passband, a resonance that screams instead of growling — and two
saturator calls per sample instead of five); and the four stage outputs are
**mixed** to yield LP24 / LP12 / BP12 / HP24 for about five multiply-adds.

Per [ADR-006](../decisions/adr-006-no-op-param-defaults.md) the default is index
`0 = LADDER`, so every existing preset, demo and share link is unchanged.

## Requirements

- **REQ-1** — `filter.model` is a discrete param, `labels: FILTER_MODEL_LABELS =
  ['ladder', 'poly']`, range `[0, 1]`, **default `0`**. The list is
  **append-only** — an index here is a stored value in every preset, song and
  share link. Changing it updates **every voice in the pool** live (`all(...)`).
  The pool is `VOICE_COUNT` (8) on the medium/strong tiers and 5 on `weak` —
  see [performance-mode](performance-mode.md).
- **REQ-2** — Both models live in **one worklet**
  (`public/worklets/ladder-filter.js`), selected by a **k-rate `model`
  AudioParam**, not by swapping nodes
  ([ADR-016](../decisions/adr-016-one-filter-worklet-model-per-block.md)). The
  model branch sits **outside** the sample loop — one loop per model — so the
  ladder's per-sample path is untouched and its output stays **bit-identical**
  to the frozen reference (`runtime-performance.md` REQ-8).
- **REQ-3** — **POLY preserves the low end.** The resonance compensation is a
  *pre*-gain on the loop input, `v = x * (1 + res*BASS_COMP) - res*fb`, which
  cancels the `1/(1+res)` that the feedback subtraction would otherwise cost the
  low end. `RES_MAKEUP` is not applied in this path. Measured on a sub-cutoff
  sine as resonance sweeps `0 → 4.2`, LADDER **loses ~7 dB** of low end while
  POLY **gains ~3 dB**. Flat was the design target; the residual rise is the
  saturating feedback under-subtracting at high resonance, and it is kept —
  "crank the resonance and the bottom thickens" is the musical inverse of the
  ladder's flaw, which is the whole point of the model.
- **REQ-4** — POLY saturates **only** at the input (the `drive` stage) and on the
  feedback tap; the four one-pole stages are **linear**. This is the character
  divergence — a clean, glassy passband under drive — and it is *cheaper* than
  the ladder (2 saturator calls per sample vs 5). The input rail is
  **wider** than the ladder's: `satWide(x) = H·sat(x/H)`, `H = POLY_HEADROOM = 3`.
  The reason is structural, not cosmetic — see the note under the recurrence.
- **REQ-5** — POLY output is **finite and bounded** for any input at any setting
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) #2,
  non-negotiable). The bound is structural: `|satWide| < 3` and `|fb| < 1` bound
  the loop input at `3(1+res) + res`, and four linear one-poles with
  `g ∈ (0,1)` are strictly stable, so no state can exceed it. Measured worst
  case — full-scale noise × `drive 8` × `resonance 4.2` × HP24 — peaks near 13,
  inside the ceiling the ladder's own boundedness test already uses.
- **REQ-6** — `filter.shape` (`[0, 1]`, **default `0`**) morphs the pole mix
  across four anchors — **LP24 → LP12 → BP12 → HP24** — as a linear crossfade
  between adjacent anchors. `0` is LP24, so the default is a plain 4-pole
  low-pass and the param is a no-op. The resonance feedback is always taken from
  the **fourth** pole in every mode, so the peak tracks cutoff throughout.
- **REQ-7** — `SHAPE` is **POLY-only**. Under LADDER the DSP ignores it and the
  UI dims the knob. The ladder's taps are saturated, so the binomial
  cancellation that makes the high-pass anchors work would leak low end.
- **REQ-8** — The five mix coefficients are resolved **once per block** when the
  `shape` array is all-equal (the common case — the LFO is permanently connected,
  so a full 128-length array always arrives), with a **per-sample** fallback when
  it is genuinely modulated. Same scan-with-early-exit shape as
  [ladder-filter.md](ladder-filter.md) REQ-11.
- **REQ-9** — Switching model **mid-note is safe**: the four pole states carry
  over (they mean the same thing in both models, so the switch is a character
  crossfade, not a reset), and the ladder's carried saturations are **re-primed**
  from the current states on the switching block so the ladder path resumes
  self-consistent. Output stays finite across the switch.
- **REQ-10** — **Level matching**: `POLY_TRIM` is tuned so that at the *default*
  resonance (0.5) the two models put out the same **passband** level — within
  0.1 dB on a sub-cutoff sine — so flipping the switch is an A/B of character
  rather than of loudness. Two honest caveats. Away from that resonance they
  diverge by REQ-3's ~10 dB, which is the feature. And **broadband** POLY reads
  about **2 dB hotter** on harmonically rich material (measured on the `basic`
  patch's two saws), because its linear stages pass harmonics the ladder's
  per-stage saturation compresses away — brightness, not gain. Trimming that out
  would drag the passband *below* the ladder and undo REQ-3's whole point.
- **REQ-11** — `shape` is reachable as an **LFO destination** (`'shape'`
  appended to `LFO_DEST_LABELS`) and, with no extra code, as an **XY-pad axis**
  and a **motion-sequencer lane** — both address `ParamBus` ids directly. The
  LFO's `toShape` hangs off the **smoothed** LFO output (like `toAmp`/`toPan`,
  not the raw path used by `toCutoff`): a square LFO stepping filter
  coefficients would click.
- **REQ-12** — Every factory preset carries `filter.model` and `filter.shape`
  explicitly. Factory presets set the *full* sound ([presets.md](presets.md)
  REQ-2b), so an omitted key would leak the previous patch's model on a preset
  change.
- **REQ-13** — The shared worklet contracts apply to **both** models unchanged:
  the `setActive` idle gate ([ladder-filter.md](ladder-filter.md) REQ-10), the
  block-constant cutoff coefficient hoist (REQ-11), the mono node (REQ-9), and
  `cutoffNote` in MIDI-note units with additive semitone modulation
  ([ADR-005](../decisions/adr-005-cutoff-as-midi-note.md)).

## Technical design

### Contract / public interface

```yaml
LadderFilterNode:  # src/audio/ladder-filter/node.ts — hosts BOTH models
  model:  AudioParam   # k-rate, 0..1, 0 = ladder (REQ-1)
  shape:  AudioParam   # a-rate, 0..1, pole-mix morph; LFO sums in here (REQ-6/11)
  # (+ cutoffNote / resonance / drive / setActive per ladder-filter.md)
Voice setters (per-voice, called by the engine):
  setFilterModel(m) / setFilterShape(s)
LFO:  # src/audio/lfo.ts
  toShape: GainNode    # fed from the SMOOTHED oscillator path (REQ-11)
```

### Data shapes (registry)

```yaml
filter.model: { range: 0..1, default: 0, step: 1, taper: discrete, labels: FILTER_MODEL_LABELS }
filter.shape: { range: 0..1, default: 0, format: fmtFilterShape }   # names the nearest anchor
FILTER_MODEL_LABELS: ['ladder', 'poly']   # APPEND-ONLY (REQ-1)
LFO_DEST_LABELS:     [..., 'shape']       # APPEND-ONLY, index 6 (REQ-11)
```

### The POLY recurrence

Same cascade, same half-sample feedback tap, three divergences (REQ-3/4/6):

```js
const q3 = sat(s3);
const fb = (q3 + q3prev) * 0.5;            // half-sample tap, as the ladder
const x  = satWide(inCh[i] * drive);       // saturator #1 of 2 (REQ-4)
const v  = x * (1 + res * BASS_COMP) - res * fb;   // bass preservation (REQ-3)
s0 += g * (v  - s0);                       // linear stages (REQ-4)
s1 += g * (s0 - s1);
s2 += g * (s1 - s2);
s3 += g * (s2 - s3);
q3prev = q3;
outCh[i] = (cv*v + c0*s0 + c1*s1 + c2*s2 + c3*s3) * POLY_TRIM;   // REQ-6/10
```

**Why POLY's input rail is wider than the ladder's** (REQ-4) — this is the one
non-obvious thing in the model, and it was found by measurement. The ladder
feeds back `sat(s_n)` *inside* each stage, so at DC `sat(s_n) === v` and the
state settles at `sat⁻¹(v)`: the cascade **undoes** its own input saturation,
which is why a filter that saturates in five places still measures near-unity at
low frequency. POLY's stages are linear, so nothing undoes it — a tight `sat()`
at the input showed up directly as ~3.5 dB of level-dependent compression, the
exact growl POLY exists *not* to have, and it dragged POLY 3.5 dB below LADDER.
Widening the rail to `H = 3` (slope 1 at the origin, bounded to ±3) is
transparent at instrument levels (~1.4 dB at a 0.5 peak) while leaving `drive`
its bite (~6 dB of compression at `drive 6`). Do not "simplify" it back to
`sat()`.

Anchor coefficient vectors over `[v, s0, s1, s2, s3]` — binomial, i.e.
`HP_n = (1 - LP)^n` applied to the loop input:

```yaml
# shape  mode   [v, s0, s1, s2, s3]     DC   Nyquist
0.00:  LP24  [ 0,  0,  0,  0,  1]       1     0
0.33:  LP12  [ 0,  0,  1,  0,  0]       1     0
0.67:  BP12  [ 0,  2, -2,  0,  0]       0     0
1.00:  HP24  [ 1, -4,  6, -4,  1]       0     1
```

`t = shape*3`, `seg = floor(t)`, lerp anchor `seg` → `seg+1` by `t - seg`.

**Tuning constants are ear calls, not derivations** — the stance
[ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) takes on
`RES_MAKEUP`. `BASS_COMP` (1.0), `POLY_HEADROOM` (3) and `POLY_TRIM` (0.85,
REQ-10) were placed by measurement and settled by listening, so changing them is
a judgement call, not a bug fix.

### Layer touchpoints & ordering

```yaml
1_registry:  src/state/params.ts  -> registerDefaults()   # filter.model, filter.shape
2_engine:    src/audio/engine.ts  -> subscribeParams()
   filter.model -> all((v, x) => v.setFilterModel(x))
   filter.shape -> all((v, x) => v.setFilterShape(x))
   per-voice wiring: lfo.toShape.connect(v.filter.shape)   # beside the toCutoff connect
3_ui:        src/ui/app.ts  -> FILTER panel: Segmented('filter.model') + SHAPE knob
             SHAPE is dimmed while filter.model === 0 (REQ-7)
init order:  unchanged — one loadModule, one node per voice
```

### Persistence

Nothing new. `filter.*` is a patch param by prefix (`isPatchParam`), so both ids
are snapshotted, restored and shared automatically; a file that predates them
falls back to the registered defaults (ADR-006). `SONG_VERSION` does **not**
move — new scalars never bump it (ADR-007).

### Worklet message contract

Unchanged. The `port` still carries only the boolean active flag
([ladder-filter.md](ladder-filter.md) REQ-10), shared by both models — model
selection travels as an AudioParam, not a message, so it is sample-scheduled and
automatable like everything else.

## Visual aids

```
                     LADDER                         POLY
 res high    |    /\                        |    /\
             |___/  \                       |______/  \
             |       \                      |          \
             +----------------              +----------------
             body sags with res             body holds at unity gain

 SHAPE  0.00 --------- 0.33 --------- 0.67 --------- 1.00
        LP24           LP12           BP12           HP24
        dark           open           hollow         thin
```

## Scenarios (BDD)

```gherkin
Scenario: The model switch is live and fans out to every voice
  Given the audio engine is running
  When the user clicks the POLY segment
  Then bus.get('filter.model') returns 1
  And every voice's filter model AudioParam reads 1
# pinned by: tests/state/params.test.ts, e2e/controls.spec.ts

Scenario: The default model leaves the ladder bit-identical (regression)
  Given filter.model is at its default 0
  When a block is processed
  Then every output sample equals the frozen naive ladder reference
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: POLY holds its low end as resonance rises (headline)
  Given a sine well below cutoff
  When resonance sweeps 0 -> 4.2 under POLY
  Then the output amplitude does not fall — it rises slightly
  And the same sweep under LADDER loses roughly 7 dB
  And the two models measure within 0.5 dB of each other at the default resonance
# pinned by: tests/audio/poly-filter-worklet.test.ts

Scenario: POLY is bounded at any setting (stability)
  Given full-scale noise, maximum drive and maximum resonance
  When many blocks are processed at several SHAPE values
  Then every output sample is finite and below a sane ceiling
  And with zero input at maximum resonance it self-oscillates rather than dying
# pinned by: tests/audio/poly-filter-worklet.test.ts

Scenario: SHAPE morphs from low-pass to high-pass (edge)
  Given POLY with cutoff in the middle of the band
  When SHAPE is 0
  Then energy well above cutoff is strongly attenuated
  When SHAPE is 1
  Then energy well below cutoff is strongly attenuated instead
# pinned by: tests/audio/poly-filter-worklet.test.ts

Scenario: A block-constant SHAPE hoist matches the per-sample path (perf)
  Given the same input and SHAPE value
  When one processor receives an all-equal 128-length shape array
  And another receives a shape array that varies around it
  Then the all-equal run equals a per-sample run at that same constant value
# pinned by: tests/audio/poly-filter-worklet.test.ts

Scenario: SHAPE does nothing under LADDER (edge)
  Given filter.model is 0
  When SHAPE is swept 0 -> 1
  Then the output is unchanged sample-for-sample
# pinned by: tests/audio/poly-filter-worklet.test.ts

Scenario: Switching model mid-note stays finite and resumes clean (edge)
  Given a processor running under POLY with non-zero state
  When the model switches back to LADDER and blocks are processed
  Then every sample is finite
  And the ladder path matches a ladder processor primed to the same states
# pinned by: tests/audio/poly-filter-worklet.test.ts

Scenario: The LFO can sweep SHAPE through the smoothed path
  Given lfo.dest is 'shape'
  Then toShape carries the smoothed LFO signal, not the raw oscillator
  And every other destination gain is zero
# pinned by: tests/audio/lfo.test.ts

Scenario: An old preset without a model loads as LADDER (backward compat)
  Given a preset saved before filter.model existed
  When it is loaded
  Then filter.model sits at 0 and the patch sounds unchanged
# pinned by: tests/state/preset.test.ts

Scenario: Factory presets never leak a model (edge)
  Given the user selects POLY and then loads any factory preset
  Then that preset's own filter.model applies, because every factory preset sets it
# pinned by: tests/state/preset.test.ts
```

## Tests & verification

- Unit (DSP): `tests/audio/poly-filter-worklet.test.ts` — the DC-gain claim,
  boundedness, SHAPE anchors, the block-constant hoist, model switching.
  `tests/audio/ladder-filter-worklet.test.ts` keeps pinning the ladder path
  bit-exact. `npm test`.
- Unit: `tests/state/params.test.ts`, `tests/state/preset.test.ts`,
  `tests/audio/lfo.test.ts`.
- E2E: `e2e/controls.spec.ts` — `seg-filter.model-1`. `npm run e2e`.
- Typecheck: `npm run typecheck`.
- **By ear** — the acceptance test, not the suite
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md), procedure in
  [verify-audio-by-ear.md](../recipes/verify-audio-by-ear.md)). A/B LADDER
  against POLY on the same note at high resonance; `BASS_COMP`, `POLY_TRIM` and
  the choice of top anchor are settled by listening.

## Open questions / future

- **SHAPE on the LADDER.** The pole mix could read the ladder's taps too, but
  they are saturated, so the binomial cancellation is imperfect and the
  high-pass anchors would leak low end. Deliberately out of scope (REQ-7);
  revisit only with a measured answer.
- **HP24 vs HP12 as the top anchor.** `[1, -2, 1, 0, 0]` is the gentler
  alternative. Decided by ear during implementation; record the winner here.
- **More models.** The selector and the per-block branch generalise, so a third
  model (state-variable, Sallen-Key) is an append to `FILTER_MODEL_LABELS` plus
  one more loop.
- **Which level match is the right one** (REQ-10). `POLY_TRIM` currently matches
  the *passband*; broadband, POLY reads ~2 dB hotter on saw material. Matching
  broadband instead would cost ~2 dB of the low end the model exists to keep.
  The passband was chosen because that is what the bass-preservation claim is
  about, but it is one constant and one ear away from the other answer.
- **Burst metrics read high on BP/HP shapes, legitimately.** A band-pass strips
  the fundamental and leaves a sawtooth's edges, so `bench:metrics` reports
  ~190 bursts/s on the `basic` patch under BP12 where LP24 reports none. Verified
  as the source waveform, not the filter: the same take with a sine oscillator
  reports zero. Don't chase it as a regression.
