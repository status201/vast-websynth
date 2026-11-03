# Ladder filter

```yaml
id: ladder-filter
status: implemented
version: 9
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
  - src/ui/panels/synth-panels.ts         # the FILTER panel
```

The resonant low-pass ladder filter, the synth's main tone shaper. It is also the
**canonical worked example** of the scalar-parameter pattern (`filter.cutoff`),
referenced by the [add-a-parameter recipe](../recipes/add-a-parameter.md).

## Background / Why

A Moog-style 4-pole ladder: a self-resonant low-pass with drive, run as an
**AudioWorklet** (`public/worklets/ladder-filter.js`) for per-sample non-linear
processing. **Cutoff is a MIDI note number, not Hz** (ADR-005). The worklet takes
`cutoffNote`, so the [filter envelope](envelopes.md) and [LFO](lfo.md) sum into it
**additively in semitones** through native `AudioParam` input summation. The
on-screen value is shown in Hz.

## Requirements

- **REQ-four-filter-params** — `cutoff` (note units), `resonance`, `drive`,
  `envAmount` (bipolar semitone depth).
- **REQ-cutoff-is-note-units** — `cutoff` range `[30, 130]` note, default `90`;
  displayed in Hz, stored as a note.
- **REQ-filter-changes-reach-every-voice** — Any filter param updates **every voice
  in the pool** live: `VOICE_COUNT` (8), or 5 on the `weak` tier.
- **REQ-filter-modulation-is-additive-semitones** — Modulation is additive in
  semitone space. Cutoff is never re-expressed in Hz in the audio path; only the
  `format` function converts, for the label.
- **REQ-the-filter-worklet-module-is-awaited** — `LadderFilterNode.loadModule()`
  is awaited in `Engine.init()` before any voice is created.
- **REQ-input-and-poles-are-saturated** — `sat(x) = x / (1 + |x|)` is applied at
  the input and every pole: bounded, odd-symmetric, and not `tanh`, so there is no
  transcendental per sample (ADR-010). Feedback reads **saturated** states
  (`|fb| < 1`), so output is finite and bounded for any input at any resonance.
- **REQ-self-oscillation-stays-gentle** — At max resonance it self-oscillates
  gently and self-limits. `sat'(0) === 1`, so low-level, low-resonance tone
  matches the linear ladder and presets are preserved.
- **REQ-resonance-uses-a-power-taper** — `resonance` uses a **`power`** taper
  (`curve < 1`) for finer resolution near self-oscillation. It is a UI mapping
  only; the stored `[0, 4.2]` range is unchanged.
- **REQ-the-filter-worklet-is-mono** — The node is **mono** (`channelCount: 1`,
  `outputChannelCount: [1]`). The voice path is mono end to end, and stereo first
  appears downstream by up-mix. A stereo node would compute identical samples
  twice (ADR-010 *cheap*).
- **REQ-the-filter-idles-when-gated** — A k-rate `active` AudioParam gates the
  per-sample DSP. On its active-to-idle edge the processor zeroes its state once;
  while idle it outputs silence and skips all per-sample work. The oscillators feed
  the filter forever and the VCA is downstream, so input-silence detection could
  never fire; the gate is the only workable one. `noteOn` sets it **unconditionally**,
  and the param **defaults to 1**, so a missed idle write can only waste CPU, never
  silence a note.
- **REQ-the-gate-is-scheduled-not-messaged** — `setActive` writes `active` with
  `setValueAtTime` at `currentTime`, the clock the envelope schedules its attack
  on (at `when >= currentTime`), so the filter is awake by the block the VCA opens
  in. A port message is serviced whenever the audio thread gets to it, so nothing
  orders it against the note's automation: a late one would start the note on
  silence and jump the filter in under an open VCA. This holds by construction;
  the note-on click it was suspected of is [voicing](voicing.md)
  REQ-a-live-note-starts-ahead-of-the-render.
- **REQ-filter-coefficients-hoist-per-block** — The pole coefficient `g` costs a
  `pow` + `exp` per sample. When every `cutoffNote` sample in a quantum is equal,
  `g` is computed **once per block** and cached until the constant changes. A
  varying block stays per-sample. Output is **bit-identical** either way. The env
  and LFO are permanently connected, so the host always delivers a full 128-array.
  The constancy scan exits early and runs **after** the idle early-out.
- **REQ-the-sat-carry-is-per-sample** — The naive recurrence calls `sat()` ten
  times per sample, and five of those repeat a value already produced. The
  processor **carries** `sat(s0..s2)` and the previous `sat(s3)` in per-channel
  state (`Float64Array(8)`), so it makes 5 calls instead of 10. Output is
  **bit-identical** to a frozen naive reference under drive + resonance
  ([runtime-performance](runtime-performance.md)
  REQ-a-worklet-optimisation-is-bit-exact). `sat(0) === 0`, so zeroing on
  deactivate keeps the carries consistent.
- **REQ-drive-moves-without-a-step** — `drive` is k-rate, so a knob write, a
  motion lane or a matrix `drive` route reaches the DSP as one value per block,
  and a changed value used to land as a step in the input gain: a 1.2 -> 3 jump
  measured 10x the 3rd-difference floor on a held sine. A block whose `drive`
  differs from the previous block's **ramps linearly across the block** from the
  old value to the new one, in both models. A constant `drive` takes the
  unramped path, so the output stays bit-identical to the frozen reference.
- **REQ-ladder-is-filter-model-zero** — This is filter model `0`. The worklet also
  hosts POLY, selected by a k-rate `model` param ([filter-models.md](filter-models.md),
  ADR-016). The branch sits **outside** the sample loop, so the ladder stays
  bit-identical to its frozen reference. `filter.shape` is POLY-only
  (filter-models REQ-shape-is-poly-only). `filter.keytrack`
  ([key-tracking.md](key-tracking.md)) and the `setActive` flag serve both models.

## Technical design

### Contract / public interface

```yaml
LadderFilterNode:  # src/audio/ladder-filter/node.ts
  static loadModule(ctx): Promise<void>   # await once per context, before voices
  cutoffNote: AudioParam                  # note units; env + LFO sum in here
  setActive(on: boolean)                  # active.setValueAtTime(on ? 1 : 0, currentTime)
  # (+ resonance / drive / shape / model / keytrack params per the node's surface)
Voice setters (per-voice, called by the engine):
  setFilterCutoff(note) / setFilterResonance(r) / setFilterDrive(d) / setFilterEnvAmount(semis)
Voice lifecycle -> filter activity:
  construction     -> setActive(false)   # pool voices boot idle
  noteOn()         -> setActive(true)    # unconditionally, every call
  release complete -> setActive(false)   # the noteOff releaseTimer firing
  kill()           -> setActive(false)   # voice stealing; noteOn re-activates after
```

### Data shapes (registry)

```yaml
filter.cutoff:    { range: 30..130, default: 90, format: fmtNoteFromCutoff }  # NOTE units
filter.resonance: { range: 0..4.2,  default: 0.5, taper: power, curve: 0.6 }
filter.drive:     { range: 0.5..6,  default: 1.2, format: "x" }
filter.envAmount: { range: -48..48, default: 24, unit: semitones }            # bipolar
# also on the FILTER panel, owned by other specs:
filter.model:     # filter-models.md — 0 = this model
filter.shape:     # filter-models.md — POLY only
filter.keytrack:  # key-tracking.md  — both models
```

The `power` taper maps `c → min + (max-min)·c^curve`. It is the only non-trivial
mapping that works at `min = 0` (`exp` requires `min > 0`).

### Layer touchpoints (the universal 3-layer scalar pattern)

```yaml
1_registry:  src/state/params.ts  -> registerDefaults()   # the filter.* ParamDefs
2_engine:    src/audio/engine.ts  -> subscribeParams()
   filter.cutoff    -> all((v, x) => v.setFilterCutoff(x))      # all() fans to the whole pool
   filter.resonance -> all((v, x) => v.setFilterResonance(x))
   filter.drive     -> all((v, x) => v.setFilterDrive(x))
   filter.envAmount -> all((v, x) => v.setFilterEnvAmount(x))
3_ui:        src/ui/panels/synth-panels.ts -> FILTER panel (CUTOFF / RESO / DRIVE / ENV knobs)
init order:  Engine.init() awaits LadderFilterNode.loadModule() before creating voices
```

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
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: Idle gating skips the DSP and restarts clean (perf)
  Given the processor received an inactive message on its port
  When blocks are processed
  Then the output is all zeros and the internal state is zeroed
  When an active message arrives and blocks are processed again
  Then the filter behaves like a freshly constructed one (bounded, filtering)
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: A block-constant cutoff hoist is bit-identical to per-sample (REQ-filter-coefficients-hoist-per-block, perf)
  Given the same input and cutoff value
  When one processor receives a full 128-length all-equal cutoffNote array
  And another receives a length-1 cutoffNote array
  Then their outputs are equal sample-for-sample
  And changing the constant cutoff across later blocks stays equal (cache invalidates)
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: The sat() carry is bit-identical to the naive recurrence (REQ-the-sat-carry-is-per-sample, perf)
  Given full-scale noise, a driven input and resonance high enough that every sat() matters
  When the block is processed
  Then every output sample equals a frozen reference that recomputes sat() everywhere
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: A deactivate clears the carried saturations too (REQ-the-sat-carry-is-per-sample, edge)
  Given a processor with non-zero stage state and carries
  When it is deactivated and then reactivated
  Then its output matches a fresh processor on the same input, sample-for-sample
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: A varying cutoff block stays per-sample accurate (REQ-filter-coefficients-hoist-per-block, edge)
  Given a cutoffNote array that steps low→high partway through a block
  When the block is processed
  Then the coefficient tracks the value per sample (the hoist does not fire)
  And the high-cutoff half passes energy the all-low run does not
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: The gate wakes the filter on the envelope's clock (REQ-the-gate-is-scheduled-not-messaged, regression)
  Given a pool voice whose filter is idle
  When noteOn fires
  Then active is set to 1 with setValueAtTime at the context's currentTime, not by a port message
  And the attack is anchored at or after that time
  And the worklet runs its DSP on the first block whose active param reads 1
# pinned by: tests/audio/voice.test.ts, tests/audio/ladder-filter-worklet.test.ts

Scenario: A lost deactivate can only cost CPU, never a note (safety edge)
  Given a voice whose filter missed a setActive(false)
  When the voice is allocated again and noteOn fires
  Then setActive(true) is scheduled unconditionally and the note sounds
# pinned by: tests/audio/voice.test.ts

Scenario: A drive change ramps across the block instead of stepping (REQ-drive-moves-without-a-step, regression)
  Given a quiet sine held through the open filter at drive 1.2
  When the next block arrives with drive 2
  Then the output's second difference across the change stays within 1.5x its steady state
  And a block whose drive did not change still equals the frozen reference
# pinned by: tests/audio/ladder-filter-worklet.test.ts

Scenario: Adding a second model left this one bit-identical (REQ-ladder-is-filter-model-zero, regression)
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

- `tests/state/params.test.ts`, `tests/audio/ladder-filter-worklet.test.ts` (stubs
  the AudioWorklet globals and imports the real worklet), `tests/audio/voice.test.ts`
  (the active-flag lifecycle), `tests/ui/taper.test.ts`, `e2e/controls.spec.ts` —
  `npm test` / `npm run e2e`.

## Open questions / future

- **Splitting the sample loop into constant and modulated paths was measured and
  declined.** Constant-folding the four loop-invariant flags fell inside run-to-run
  noise, because the branches are perfectly predicted. A second copy of the
  recurrence would break ADR-016's one canonical copy. Re-open only with a device
  profile showing this loop dominating.
- The per-block constancy scans are already near optimal: proving constancy reads
  every element, and a modulated block exits on the first difference.
