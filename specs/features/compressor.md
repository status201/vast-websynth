# Compressors (AudioWorklet feature)

```yaml
id: compressor
status: implemented
version: 5
owner: core
related:
  - architecture
  - effects
  - runtime-performance
  - ../decisions/adr-002-audioworklet-compressor
  - ../decisions/adr-010-musical-stable-cheap-dsp
source:
  - public/worklets/compressor.js     # the DSP (audio thread)
  - src/audio/compressor/node.ts      # CompressorNode wrapper
  - src/audio/effects/compressor.ts   # Compressor Effect (BypassWrapper)
  - src/audio/engine.ts               # calls Compressor.bind + attachWorklet
  - src/state/params.ts               # the fx.drum.comp.* / fx.master.comp.* defs
  - src/ui/panels/drum-panel.ts       # drum comp UI
  - src/ui/panels/song-panel.ts       # master comp UI + GrMeter
```

A scalar feature with extra structure: an `AudioWorklet`, **index-valued**
parameters mapped to real values, an async attach lifecycle, and a `port` message
contract that feeds a UI meter. It is the template for a worklet-backed effect.

## Background / Why

One `hardware-compressor` worklet provides two character modes, fixed per
instance via `processorOptions.mode`:

- **`fet`** (1176 style): feedback detector, hard knee, microsecond attacks,
  program-dependent release, tanh saturation. On the **drum** bus, the first
  effect after the EQ ([effects](effects.md) REQ-the-drum-bus-chain-order).
- **`vca`** (SSL G-bus style): feed-forward detector, 6 dB soft knee, clean gain,
  auto-release. On the **master** bus, `djLow → djHigh → masterComp → analyser`
  ([performance](performance.md) REQ-the-dj-filter-is-a-series-pair).

The UI exposes the hardware's **discrete** ratio/release switches (`4:1`, `8:1`, …
`ALL`), and the engine maps the indices to real values. Both modes favour
character over circuit accuracy (ADR-010) and are bounded and cheap.

## Requirements

- **REQ-one-worklet-two-models** — A single worklet (`hardware-compressor`)
  supports both `fet` and `vca` via `processorOptions.mode`, fixed at
  construction.
- **REQ-two-compressors-two-buses** — Drum compressor on the drum bus (`fet`);
  master compressor `djLow → djHigh → masterComp → analyser` (`vca`).
- **REQ-ratio-and-release-are-indices** — Ratio/release are stored as **indices**
  and the engine maps them. FET ratio → `[4, 8, 12, 20, 100]` (`100` = "all
  buttons in"). A master release index **past the table end** → auto-release.
  **A discrete param snaps; only a continuous one is smoothed.** `ratio` and
  `autoRelease` are written with `setValueAtTime`. `setTargetAtTime` would pass
  through ratios the UI does not offer, and reach the worklet's `ratio >= 100` test
  only after ~ten time constants. Threshold, attack, release and makeup are
  smoothed. `attachWorklet` seeds all six with `setValueAtTime`.
- **REQ-worklet-posts-gain-reduction** — The worklet posts gain reduction (dB) on
  its `port` at ~31 Hz. The `GrMeter` renders it.
- **REQ-compressor-graph-is-wired-synchronously** — The graph is wired
  **synchronously** in `Engine`'s constructor. The worklet node is **spliced in
  after** `loadModule` via `attachWorklet()`, replaying cached setter values.
- **REQ-coefficients-derive-on-change** — The envelope and makeup coefficients are
  functions of the six k-rate params alone, and `mkA`/`dcR` of the sample rate. So
  the rate-only pair is computed **once at construction**, and the param-derived
  set **only when one of those params changes**, not per block (ADR-010 *cheap*,
  bounded by REQ-the-coefficient-memo-is-bit-exact).
- **REQ-the-coefficient-memo-is-bit-exact** — Caching MUST produce the identical
  value (same expression, same operand order), and every param the cache reads
  MUST invalidate it (`runtime-performance.md`
  REQ-a-worklet-optimisation-is-bit-exact). This is pinned by frozen-reference
  vectors that include a mid-stream k-rate change. The per-sample dB conversions
  are written as `k·log` and `exp(y·k)`, about 2.6× cheaper than `log10`/`pow`.
  They are bit-exact **at the output**: the double-rounding difference is ~2e-15
  relative, far below a float32 ULP.
- **REQ-a-silent-input-stays-silent** (v3) — The FET saturator is deliberately
  asymmetric (`tanh(d·(y + 0.02))/d`, the source of its 2nd harmonic), so it
  outputs ≈ `+0.02` for silence. The 10 Hz DC blocker is **primed from the first
  sample it sees** rather than from zero, so a silent first block is exactly
  silent. Without it, a demo load that un-bypassed the drum compressor thumped
  ([song-mode](song-mode.md) REQ-applying-a-song-is-click-free). The frozen vectors
  were re-captured for this, and silence-in-silence-out is pinned directly. `vca`
  has no saturation. On a silent tail the blocker's output decays geometrically;
  it is flushed to 0 below 1e-20 (−400 dB) at block end, like the envelopes, so it
  never crawls through the subnormal range.

## Technical design

### Contract / public interface

```yaml
CompressorNode:   # src/audio/compressor/node.ts
  static loadModule(ctx): Promise<void>     # await once per context, before create
  static create(ctx, mode): CompressorNode  # sync; mode: 'fet' | 'vca'
  input / output: AudioNode
  threshold / ratio / attack / release / autoRelease / makeup: AudioParam
  onGr: ((db: number) => void) | null       # gain-reduction callback (from port)

Compressor (Effect):  # src/audio/effects/compressor.ts
  # builds its BypassWrapper synchronously so Engine can wire chains in its ctor; no setMix
  attachWorklet()      # splices the real node in (after loadModule) + replays setters
  bind(bus, prefix, ratios, releases?)  # self-wires its params + the index→real maps
  setBypass / setThreshold / setRatio / setAttack / setRelease / setAutoRelease / setMakeup
```

### Data shapes (the registry)

```yaml
# Drum: 1176 FET style — ratio is an index
fx.drum.comp.on:        { discrete, labels: [off, on], default: 0 }
fx.drum.comp.threshold: { min: -40, max: 0,   default: -18 }
fx.drum.comp.ratio:     { discrete, labels: ['4:1','8:1','12:1','20:1','ALL'], default: 0 }
fx.drum.comp.attack:    { min: 0.00002, max: 0.0008, default: 0.0002, taper: exp }
fx.drum.comp.release:   { min: 0.05, max: 1.1, default: 0.25, taper: exp }
fx.drum.comp.makeup:    { min: 0, max: 24, default: 0 }

# Master: SSL G VCA style — ratio AND release are indices
fx.master.comp.on:        { discrete, labels: [off, on], default: 0 }
fx.master.comp.threshold: { min: -40, max: 0, default: -12 }
fx.master.comp.ratio:     { discrete, labels: ['2:1','4:1','10:1'], default: 1 }
fx.master.comp.attack:    { min: 0.0001, max: 0.03, default: 0.01, taper: exp }
fx.master.comp.release:   { discrete, labels: ['0.1s','0.3s','0.6s','1.2s','auto'], default: 4 }
fx.master.comp.makeup:    { min: 0, max: 12, default: 0 }
```

### Index → real-value mapping

```yaml
drum:   drumComp.bind(bus, 'fx.drum.comp',     [4, 8, 12, 20, 100])
master: masterComp.bind(bus, 'fx.master.comp', [2, 4, 10], [0.1, 0.3, 0.6, 1.2])
rules:
  ratio:   comp.setRatio(ratios[round(x)] ?? ratios[0])
  release: if releases given and round(x) >= releases.length -> setAutoRelease(true)
           else setRelease(releases[round(x)])
  ratio==100 (fet): worklet engages "all buttons in" (near-limiting + overshoot)
```

### Layer touchpoints & ordering (the async-worklet lifecycle)

```yaml
ctor (sync):  engine builds Compressor effects -> BypassWrapper wired into chains
init (async): await CompressorNode.loadModule(ctx)
              drumComp.attachWorklet(); masterComp.attachWorklet()  # splice + replay
              drumComp.bind(...) / masterComp.bind(...) wire params to the bus
```

The constructor must wire synchronously, but an `AudioWorkletNode` needs its
module first. The `BypassWrapper` is the placeholder. The splice happens *inside*
the processed path (`processedIn → node → processedOut`), so it works even while
bypassed and disconnected (ADR-012).

### Worklet message contract

```yaml
direction: worklet -> main (node.port.onmessage)
payload:   number               # bare gain reduction in dB (>= 0)
rate:      ~31 Hz               # 12 × 128 frames at 48 kHz
when:      suppressed while idle (no reduction)
consumer:  CompressorNode.onGr -> GrMeter UI (testid grmeter-<prefix>)
params (k-rate AudioParams, NOT messages):
  threshold, ratio, attack, release, autoRelease, makeup
```

## Visual aids

```
drumBus ─► drumEq ─► drumComp (FET) ─► drumPhaser ─► drumDelay ─► drumReverb ─► preMaster
preMaster ─► djLow ─► djHigh ─► masterComp (VCA) ─► analyser ─► master
                              │ port (gain reduction dB, ~31 Hz)
                              └─────────────► GrMeter (grmeter-fx.master.comp)
```

## Scenarios (BDD)

```gherkin
Scenario: Turning the compressor on engages the worklet
  Given the engine is running
  When the user toggles fx.master.comp.on to 1
  Then the master compressor stops bypassing and processes audio
  And a grmeter-fx.master.comp element is present
# pinned by: e2e/compressor.spec.ts

Scenario: Discrete ratio index maps to the real ratio
  Given fx.drum.comp.ratio is set to index 4 (label 'ALL')
  Then the worklet ratio AudioParam is 100 ("all buttons in")
# pinned by: tests/audio/effects/compressor.test.ts

Scenario: Master release index past the table means auto-release (edge)
  When fx.master.comp.release is set to index 4 (label 'auto')
  Then setAutoRelease(true) is called and no fixed release is applied
# pinned by: tests/audio/effects/compressor.test.ts

Scenario: DSP curve under signal (failure guard)
  Given a signal above threshold into the fet processor
  Then gain reduction is produced and posted on the port
# pinned by: tests/audio/compressor-worklet.test.ts (worklet DSP imported directly)

Scenario: The coefficient memo survives a block boundary (REQ-coefficients-derive-on-change)
  Given a processor has rendered a block with a given set of k-rate params
  When the next block arrives with those params unchanged
  Then the envelope coefficients are reused rather than recomputed
  And the output samples are identical to recomputing them
# pinned by: tests/audio/compressor-worklet.test.ts (bit-exact digests)

Scenario: A knob turn invalidates the memo mid-stream (REQ-the-coefficient-memo-is-bit-exact, regression)
  Given a processor is compressing with one set of k-rate params
  When threshold, ratio, attack, release, autoRelease and makeup all change
       between two blocks
  Then the new coefficients take effect on the very next block
  And the output matches the un-memoized implementation sample for sample
# pinned by: tests/audio/compressor-worklet.test.ts
#            ('vca/fet, k-rate params change mid-stream')

Scenario: A silent tail settles the DC blocker to exactly zero (REQ-a-silent-input-stays-silent, regression)
  Given a FET compressor that has passed a signal
  When it is fed silence for a second
  Then its DC-blocker state is exactly 0, not a subnormal on its way there
# pinned by: tests/audio/compressor-worklet.test.ts
```

## Tests & verification

- `tests/audio/compressor-worklet.test.ts` (stubs worklet globals, imports
  `public/worklets/compressor.js`): loose physics assertions, plus frozen-reference
  digests of the float32 output across both modes, `all` buttons, both release
  paths, the mono fallbacks and a mid-stream k-rate change.
  `tests/audio/effects/compressor.test.ts` covers the wrapper and the index
  mapping. `e2e/compressor.spec.ts` — `npm test` / `npm run e2e`.

## Open questions / future

- The mode is fixed per instance by design. A switchable mode needs a new param +
  worklet re-instantiation.
- **Splitting the sample loop on `fet` was measured and declined**: at best ~5 % in
  fet mode and nothing in vca, for two copies of hand-tuned DSP to keep in step.
  Revisit only with a profile showing the compressor loop is the bottleneck.
- A dB↔linear lookup table would be cheaper still but is **not bit-exact**, so it
  is a sound change (REQ-a-worklet-optimisation-is-bit-exact) and needs its own
  spec and an ADR-010 justification.
