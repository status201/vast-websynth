# Compressors (AudioWorklet feature)

```yaml
id: compressor
status: implemented
version: 1
owner: core
related:
  - architecture
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

A scalar feature with **extra structure**: it spans an `AudioWorklet` (its own DSP
on the audio thread), discrete **index-valued** parameters mapped to real values,
an async attach lifecycle, and a `port` **message contract** that feeds a UI meter.
A good template for any worklet-backed effect.

## Background / Why

One `hardware-compressor` worklet provides two hardware-modelled character modes,
fixed per instance via `processorOptions.mode`:

- **`fet`** (UREI 1176 style): feedback detector, hard knee, microsecond attacks,
  program-dependent release, FET-ish tanh saturation. Heads the **drum** chain
  (`engine.drumComp`).
- **`vca`** (SSL G-bus style): feed-forward detector, 6 dB soft knee ("glue"),
  clean VCA gain, auto-release. Sits `djFilter → masterComp → analyser` on the
  **master** bus (`engine.masterComp`).

The UI exposes musician-friendly **discrete** ratio/release switches (e.g. `4:1`,
`8:1`, … `ALL`); the engine maps those indices to the real numeric values the
worklet expects. This keeps the param registry simple and the controls authentic
to the modelled hardware.

Both modes are tuned for **recognisable character over circuit accuracy** — the
*musical, stable, cheap* stance that governs the DSP worklets
([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)): the FET's feedback
detector and program-dependent release, the VCA's soft-knee "glue" auto-release,
and "all buttons in" are chosen for *feel*; the DSP is bounded (unit-tested for
boundedness) and runs cheaply on the audio thread.

## Requirements

- **REQ-1** — A single worklet (`hardware-compressor`) supports both `fet` and
  `vca` via `processorOptions.mode`, fixed at construction.
- **REQ-2** — Drum compressor sits on the drum bus (`fet`); master compressor sits
  `djFilter → masterComp → analyser` (`vca`).
- **REQ-3** — Ratio/release params are stored as **indices**; the engine maps each
  index to a real value. FET ratio index → `[4, 8, 12, 20, 100]` (`100` = "all
  buttons in"). Master release index **past the table end** → auto-release.
- **REQ-4** — The worklet posts current gain reduction (dB) on its `port` at
  ~31 Hz; the `GrMeter` UI renders it.
- **REQ-5** — The graph is wired **synchronously** in `Engine`'s constructor;
  the worklet node is **spliced in after** `loadModule` via `attachWorklet()`,
  replaying cached setter values.

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
  # builds its BypassWrapper synchronously so Engine can wire chains in its ctor;
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

`Compressor.bind(bus, prefix, ratios, releases?)` (the index→real map lives in
the compressor effect, called once from `Engine.subscribeParams()`):

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

This split exists because `Engine`'s constructor must wire the audio graph
synchronously, but an `AudioWorkletNode` can't be created until its module is
loaded (async). The `BypassWrapper` is the placeholder; `attachWorklet()` swaps in
the real node and replays cached setter values so nothing is lost.

### Worklet message contract

```yaml
direction: worklet -> main (node.port.onmessage)
payload:   number               # bare gain reduction in dB (>= 0)
rate:      ~31 Hz               # 12 × 128 frames ≈ 31 Hz at 48 kHz
when:      suppressed while idle (no reduction)
consumer:  CompressorNode.onGr -> GrMeter UI (testid grmeter-<prefix>)
params (k-rate AudioParams, NOT messages):
  threshold, ratio, attack, release, autoRelease, makeup
```

## Visual aids

```
drumBus ─► drumComp (FET) ─► drumPhaser ─► drumDelay ─► preMaster
preMaster ─► djFilter ─► masterComp (VCA) ─► analyser ─► master
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
```

## Tests & verification

- Worklet DSP, directly: `tests/audio/compressor-worklet.test.ts` (stubs worklet
  globals, imports `public/worklets/compressor.js`).
- Effect wrapper + index mapping: `tests/audio/effects/compressor.test.ts`.
- E2E: `e2e/compressor.spec.ts` (switch, knobs, `grmeter-<prefix>` presence, help
  badges).
- `npm test` / `npm run e2e` / `npm run typecheck`.

## Open questions / future

- The mode is fixed per instance by design; a user-switchable mode would need a new
  param + worklet re-instantiation. Out of scope.
