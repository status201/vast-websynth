# Ladder filter

```yaml
id: ladder-filter
status: implemented
version: 7   # v7: this is filter model 0 of N (REQ-13)
owner: core
related:
  - architecture
  - envelopes
  - lfo
  - filter-models
  - key-tracking
  - runtime-performance
  - ../decisions/adr-005-cutoff-as-midi-note
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-016-one-filter-worklet-model-per-block
  - ../recipes/add-a-parameter
source:
  - public/worklets/ladder-filter.js     # the DSP (audio thread, plain JS)
  - src/audio/ladder-filter/node.ts       # LadderFilterNode wrapper
  - src/state/params.ts                   # filter.* ParamDefs
  - src/audio/engine.ts                   # subscribeParams (per-voice)
  - src/utils/taper.ts                    # power-taper knob mapping
  - src/ui/app.ts                         # the FILTER panel
```

The resonant low-pass ladder filter — the synth's main tone shaper. It is also the
**canonical worked example** of the repo's universal scalar-parameter pattern
(`filter.cutoff` is the smallest, clearest case), referenced by the
[add-a-parameter recipe](../recipes/add-a-parameter.md).

## Background / Why

A Moog-style 4-pole ladder gives the synth its character: a self-resonant low-pass
with drive. It runs as an **AudioWorklet** (`public/worklets/ladder-filter.js`,
plain JS on the audio thread) so it can do per-sample non-linear processing.

**Per-stage saturation (v2).** A cheap, bounded, odd-symmetric rational
nonlinearity — `sat(x) = x / (1 + |x|)` — is applied at the input *and* at every
pole (the transistor-ladder character: smooth overdrive, gentle self-limiting
self-oscillation). It is deliberately **not** `tanh` — no transcendental per
sample keeps it *cheap*. Two invariants fall out of the shape: `sat'(0) === 1`,
so at low level / low resonance the response matches the linear ladder and
existing presets are preserved; and the feedback is taken from **saturated**
states (`|fb| < 1`), so the loop is bounded and **cannot run away to NaN** at any
resonance. This is the "musical, stable, cheap" trade in code — the worklet-wide
stance recorded in [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md).

The load-bearing convention: **cutoff is a MIDI note number, not Hz.** The worklet
takes `cutoffNote`, so the [filter envelope](envelopes.md) and [LFO](lfo.md) can sum
into the cutoff **additively in semitones** via Web Audio's native `AudioParam`
input summation — musical modulation that stacks cleanly, rather than multiplying
frequencies. The on-screen value is still shown in Hz for the user.

## Requirements

- **REQ-1** — Four filter params: `cutoff` (note units), `resonance`, `drive`,
  `envAmount` (bipolar semitone depth).
- **REQ-2** — `cutoff` range `[30, 130]` note, default `90`; displayed in Hz but
  stored as a note number.
- **REQ-3** — Changing any filter param updates **all 8 voices** live.
- **REQ-4** — Modulation (filter envelope, LFO) is **additive in semitone space**;
  cutoff must not be re-expressed in Hz anywhere in the audio path.
- **REQ-5** — `LadderFilterNode.loadModule()` is awaited (in `Engine.init()`)
  before any voice is created.
- **REQ-6** — The input and every pole are saturated with a bounded rational
  nonlinearity. Output stays **finite and bounded** for any input at any
  resonance (no NaN / runaway) — the feedback path reads saturated states.
- **REQ-7** — At max resonance the filter self-oscillates **gently and
  self-limits** (no explosion). Because `sat'(0) === 1`, low-level / low-resonance
  tone matches the pre-v2 linear ladder.
- **REQ-8** — The `resonance` knob uses a **`power` taper** (`curve < 1`) for
  finer resolution near self-oscillation. The taper is a UI knob mapping only;
  the stored value and its `[0, 4.2]` range are unchanged, so presets are
  unaffected.
- **REQ-9** — The worklet node is **mono** (`channelCount: 1`,
  `outputChannelCount: [1]`, v3). The voice path is mono end-to-end (mono
  oscillators/noise → gains → filter → gains); stereo first materialises
  downstream (drum panners, stereo reverb IRs) by up-mix. Forcing the node
  stereo (pre-v3) merely computed identical samples twice — per ADR-010
  (*cheap*), the duplicate channel is dropped. Output is bit-identical after
  the downstream mono→stereo up-mix.
- **REQ-10** — **Idle gating** (v4): an *active flag* posted over the worklet
  port gates the per-sample DSP. While inactive the processor zeroes its state
  once, outputs silence, and skips all per-sample work (the pow/exp/sat loop).
  The voice's oscillators feed the filter forever and the amp VCA sits
  *downstream*, so input-silence detection can never fire — the flag is the
  only workable gate. Safety asymmetry: `noteOn` posts `true`
  **unconditionally on every call**, so a lost `false` can only waste CPU,
  never silence a note. The worklet **defaults to active** for the same
  reason. Any activation step is inaudible by construction: the downstream
  ampVCA is already closed whenever the flag flips (masking invariant).
- **REQ-11** — **Block-constant coefficient hoist** (v5): the cutoff→Hz→pole
  coefficient `g` costs a `Math.pow` + `Math.exp` per sample. When every
  `cutoffNote` sample in a render quantum is equal, `g` is computed **once per
  block** (and cached across blocks — recomputed only when the block's constant
  cutoff value changes), reusing it for both the loop and channels; a block
  whose samples differ still gets a **per-sample** (a-rate) coefficient. Output
  is **bit-identical** to the per-sample path in both cases (same expression,
  same order). This matters because the old `cutoffArr.length === 1` fast path
  is *dead code*: the filter envelope (`voice.ts`) and the global LFO
  (`engine.ts`) are permanently connected to the `cutoffNote` `AudioParam`, so
  the host always delivers a full 128-length array — usually all-equal (a held
  or unmodulated cutoff), the common case this hoist now covers. Detecting
  constancy is a full scan with early exit (`~1` compare when modulated), run
  **after** the REQ-10 idle early-out so a silent voice still does no work. This
  is the "cheap" half of *musical, stable, cheap*
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)) — the single
  biggest per-sample saving for the common held-cutoff case, with no audible
  change.
- **REQ-12** — **Per-sample `sat()` carry** (v6): the naive recurrence calls
  `sat()` **ten times per sample per channel**, but five of those recompute a
  value the previous statement — or the previous *sample* — already produced.
  Each of stages 0–2 saturates its own state twice (once as the feedback term
  inside its update, once again as the next stage's input `v`), and the
  half-sample feedback tap's `sat(s4)` is just last sample's `sat(s3)`, since
  `s4` only ever held the previous `s3`. The processor therefore **carries**
  `sat(s0)`, `sat(s1)`, `sat(s2)` and the previous `sat(s3)` in per-channel
  state (a `Float64Array(8)`: four pole states + four carried saturations),
  computing `sat(s3)` once per sample and using it for both the feedback tap and
  stage 4's own update — **5 calls instead of 10**, each `sat()` being a divide
  plus an `abs`. The `s4` slot is gone; the carry replaces it exactly.
  Output is **bit-identical** (same operands, same order), which is the
  requirement, not a nicety: this is the only always-on per-sample cost that
  scales with polyphony (8 voices × 2 channels), so it is tempting to keep
  shaving — and the spec's promise that low-level/low-resonance response matches
  the linear ladder, hence that existing presets are preserved, depends on the
  recurrence not drifting. `sat(0) === 0`, so REQ-10's zero-the-state on
  deactivate leaves the carries self-consistent with no extra handling. Pinned
  against a frozen naive reference under drive + resonance, where every `sat()`
  call actually affects the result (see
  [`runtime-performance.md`](runtime-performance.md) REQ-8).
- **REQ-13** — **This is filter model `0` of N** (v7). The worklet also hosts the
  POLY model, selected by a k-rate `model` `AudioParam`
  ([filter-models.md](filter-models.md),
  [ADR-016](../decisions/adr-016-one-filter-worklet-model-per-block.md)). The
  model branch sits **outside** the sample loop, so everything above — the
  recurrence, the make-up gain, REQ-10/11/12 — is unchanged and the ladder's
  output remains **bit-identical** to the frozen naive reference. `filter.shape`
  belongs to POLY and is ignored here (filter-models REQ-7). Two params are
  shared: `filter.keytrack` offsets this model's cutoff exactly as it does
  POLY's ([key-tracking.md](key-tracking.md)), and the `setActive` port flag
  (REQ-10) gates both models from one place.

## Technical design

### Contract / public interface

The filter params are plain `ParamBus` parameters — readers/writers use the
standard bus surface (`bus.set`/`get`/`subscribe`). The worklet wrapper:

```yaml
LadderFilterNode:  # src/audio/ladder-filter/node.ts
  static loadModule(ctx): Promise<void>   # await once per context, before voices
  cutoffNote: AudioParam                  # note units; env + LFO sum in here
  setActive(on: boolean)                  # REQ-10 — port.postMessage(boolean)
  # (+ resonance / drive params per the node's surface)
Voice setters (per-voice, called by the engine):
  setFilterCutoff(note) / setFilterResonance(r) / setFilterDrive(d) / setFilterEnvAmount(semis)
Voice lifecycle -> filter activity (REQ-10):
  construction     -> setActive(false)   # pool voices boot idle
  noteOn()         -> setActive(true)    # unconditionally, every call
  release complete -> setActive(false)   # the noteOff releaseTimer firing
  kill()           -> setActive(false)   # voice stealing; noteOn re-activates after
```

### Data shapes (registry)

```yaml
filter.cutoff:    { range: 30..130, default: 90, format: fmtNoteFromCutoff }  # NOTE units
filter.resonance: { range: 0..4.2,  default: 0.5, taper: power, curve: 0.6 }  # power taper = finer near self-osc
filter.drive:     { range: 0.5..6,  default: 1.2, format: "x" }
filter.envAmount: { range: -48..48, default: 24, unit: semitones }            # bipolar
# also on the FILTER panel, owned by other specs:
filter.model:     # filter-models.md — 0 = this model
filter.shape:     # filter-models.md — POLY only
filter.keytrack:  # key-tracking.md  — both models
```

The `power` taper (`Taper` in `params.ts`, applied by `utils/taper.ts`)
maps knob position `c → min + (max-min)·c^curve`; `curve < 1` stretches the
high-resonance end across more knob travel. It is the only non-trivial mapping
that works at `min = 0` (`exp` requires `min > 0`).

### Layer touchpoints (the universal 3-layer scalar pattern)

```yaml
1_registry:  src/state/params.ts  -> registerDefaults()   # the filter.* ParamDefs
2_engine:    src/audio/engine.ts  -> subscribeParams()
   filter.cutoff    -> all((v, x) => v.setFilterCutoff(x))      # all() fans to 8 voices
   filter.resonance -> all((v, x) => v.setFilterResonance(x))
   filter.drive     -> all((v, x) => v.setFilterDrive(x))
   filter.envAmount -> all((v, x) => v.setFilterEnvAmount(x))   # semitone depth
3_ui:        src/ui/app.ts  -> FILTER panel (CUTOFF / RESO / DRIVE / ENV knobs)
init order:  Engine.init() awaits LadderFilterNode.loadModule() before creating voices
```

### The note-vs-Hz invariant

`setFilterCutoff` passes the note straight to the worklet's `cutoffNote`
`AudioParam`. The filter envelope and LFO are wired as **additive inputs** to that
same param (in semitones), scaled by `filter.envAmount`. Never convert cutoff to Hz
inside the audio path — only the `format` function does, and only for the label.
This is a shared invariant with [envelopes](envelopes.md) and [lfo](lfo.md).

## Visual aids

```
CUTOFF knob ──bus.set('filter.cutoff', note)──► ParamBus
ParamBus ──subscribe──► Engine.subscribeParams ──► each Voice.setFilterCutoff(note)
                                                         │
                            filterEnv (semitones) ──────►├─ ladder worklet cutoffNote
                            LFO (semitones) ────────────►┘   (additive AudioParam sum)
```

## Scenarios (BDD)

```gherkin
Scenario: Knob drag updates the live cutoff
  Given the audio engine is running
  When the user drags the CUTOFF knob to note 100
  Then bus.get('filter.cutoff') returns 100
  And every voice's ladder filter cutoffNote tracks 100
# pinned by: tests/state/params.test.ts, e2e/controls.spec.ts

Scenario: Out-of-range writes are clamped
  When code calls bus.set('filter.cutoff', 200)
  Then bus.get('filter.cutoff') returns 130   # clamped to max
# pinned by: tests/state/params.test.ts

Scenario: Value is shown in Hz but stored as a note (edge)
  Given filter.cutoff is 90
  Then the knob label reads a Hz string via fmtNoteFromCutoff
  And the stored value remains the note number 90, not a frequency
# pinned by: tests/state/params.test.ts (def/format)

Scenario: Filter envelope sweeps cutoff additively (edge)
  Given filter.cutoff is 60 and filter.envAmount is 24
  When a note triggers
  Then the effective cutoff peaks ~24 semitones above 60, summed at the AudioParam
# pinned by: envelopes.md invariant; tests/state/params.test.ts

Scenario: Self-oscillation is bounded (stability)
  Given resonance is at maximum
  When white noise or silence is processed for many blocks
  Then every output sample is finite (no NaN) and bounded below a sane ceiling
  And with zero input the filter still rings (self-oscillates) rather than dying
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: Low-resonance tone matches the linear ladder (edge)
  Given resonance is 0 and drive is ~1
  When a small-amplitude signal is processed
  Then the output tracks a linear one-pole-cascade reference within tolerance
  # sat'(0) === 1, so existing presets are preserved
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: Idle gating skips the DSP and restarts clean (perf)
  Given the processor received an inactive message on its port
  When blocks are processed
  Then the output is all zeros and the internal state is zeroed
  When an active message arrives and blocks are processed again
  Then the filter behaves like a freshly constructed one (bounded, filtering)
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: A block-constant cutoff hoist is bit-identical to per-sample (REQ-11, perf)
  Given the same input and cutoff value
  When one processor receives a full 128-length all-equal cutoffNote array
  And another receives a length-1 cutoffNote array
  Then their outputs are equal sample-for-sample
  And changing the constant cutoff across later blocks stays equal (cache invalidates)
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: The sat() carry is bit-identical to the naive recurrence (REQ-12, perf)
  Given full-scale noise, a driven input and resonance high enough that every sat() matters
  When the block is processed
  Then every output sample equals a frozen reference that recomputes sat() everywhere
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: A deactivate clears the carried saturations too (REQ-12, edge)
  Given a processor with non-zero stage state and carries
  When it is deactivated and then reactivated
  Then its output matches a fresh processor on the same input, sample-for-sample
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: A varying cutoff block stays per-sample accurate (REQ-11, edge)
  Given a cutoffNote array that steps low→high partway through a block
  When the block is processed
  Then the coefficient tracks the value per sample (the hoist does not fire)
  And the high-cutoff half passes energy the all-low run does not
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: A lost deactivate can only cost CPU, never a note (safety edge)
  Given a voice whose filter missed a setActive(false)
  When the voice is allocated again and noteOn fires
  Then setActive(true) is posted unconditionally and the note sounds
# pinned by: tests/audio/voice.test.ts

Scenario: Adding a second model left this one bit-identical (REQ-13, regression)
  Given the model param sits at its default 0
  When a driven, resonant block is processed
  Then every output sample equals the frozen naive ladder reference
  And sweeping filter.shape 0 -> 1 changes nothing
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: Resonance knob has a power taper (non-linear mapping)
  Given filter.resonance uses taper 'power' with curve < 1
  When the knob sits at its midpoint (norm 0.5)
  Then the resolved value is above the linear midpoint (0.5·max)
  And normalize/denormalize round-trip for any value in range
# pinned by: tests/ui/taper.test.ts
```

## Tests & verification

- Unit: `tests/state/params.test.ts` — registration, clamping, subscribe,
  snapshot/restore. `npm test`.
- Unit (DSP): `tests/audio/ladder-filter-worklet.test.ts` — stubs the
  AudioWorklet globals and imports the real worklet (pattern:
  `tests/audio/compressor-worklet.test.ts`): boundedness at max resonance,
  bounded self-oscillation, low-res ≈ linear reference, idle gating (REQ-10).
- Unit (lifecycle): `tests/audio/voice.test.ts` — Voice posts the active flag
  on construction/noteOn/release-complete/kill (mock AudioContext + mock
  worklet port).
- Unit (taper): `tests/ui/taper.test.ts` — `power` taper mapping +
  round-trip for `utils/taper.ts`.
- E2E: `e2e/controls.spec.ts` — drives the control surface; assert via
  `window.__synth.bus.get('filter.cutoff')`. `npm run e2e`.
- Typecheck: `npm run typecheck`.

## Open questions / future

- This spec doubles as the reference instance for the
  [add-a-parameter recipe](../recipes/add-a-parameter.md): `filter.cutoff` is the
  textbook scalar param.
- **Splitting the sample loop into constant and modulated paths was measured and
  declined.** Four flags are loop-invariant for a block — `resStatic`,
  `cutoffConst`, `shapeConst` and the `inCh` null-check — and are nonetheless
  tested on every one of the 128 samples, in both model branches, per voice. That
  reads like an obvious hoist. It is not: constant-folding all four (the *upper
  bound*, since it lets the engine delete the tests outright rather than merely
  hoist them) produced a difference **below the run-to-run noise floor** — repeated
  best-of-5 timings of the *unmodified* build spanned 735–821 ms for the same work,
  wider than any gap between the two builds, and one branchless run came out
  slower. The branches are perfectly predicted, so they cost approximately nothing.
  Paying for them with a second copy of the recurrence — which ADR-016 keeps
  byte-for-byte identical to the frozen reference precisely so there is one
  canonical copy — would trade a real maintenance hazard for an unmeasurable win.
  Re-open only with a profile from a real device showing this loop dominating.
- The two per-block constancy scans (`cutoffArr`, `shapeArr`) are already near
  optimal and were left alone: proving a block *is* constant requires reading every
  element, and a genuinely modulated block already exits on the first differing
  sample. Comparing first-against-last before scanning would help neither case.
