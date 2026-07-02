# Insert effects (distortion · wah · phaser · delay · reverb)

```yaml
id: effects
status: implemented
version: 1
owner: core
related:
  - architecture
  - compressor
  - performance
  - fx-group   # shared header FX-group UI (hides knobs while <fx>.on is off)
source:
  - src/audio/effects/effect.ts        # Effect interface + BypassWrapper
  - src/audio/effects/{distortion,wah,phaser,delay,reverb}.ts
  - src/state/params.ts
  - src/audio/engine.ts                 # calls each Effect.bind(bus, prefix)
  - src/ui/app.ts / src/ui/panels/*
```

The bypass-able insert effects on the three buses. The [compressor](compressor.md)
(a worklet) and the DJ filter ([performance](performance.md)) are specified
separately.

## Background / Why

Each effect owns a fixed `input → DSP → output` graph wired **once** at setup.
Toggling an effect must never click, so bypass is a **dry/wet crossfade**
(`BypassWrapper`) rather than a graph reconnect. The same five effects are
instantiated on the synth voice bus; the drum and sampler buses get their own
subsets, so a song can colour each bus independently.

## Requirements

- **REQ-1** — Every effect implements `Effect { input, output, setBypass }`.
- **REQ-2** — Bypass + mix are a click-free crossfade (`BypassWrapper`): wet =
  `bypassed ? 0 : mix`, dry = `bypassed ? 1 : 1 - mix`, ramped.
- **REQ-3** — Synth voice bus chain order: distortion → wah → phaser → delay →
  reverb.
- **REQ-4** — Drum bus: phaser → delay → [compressor]; sampler bus: distortion →
  phaser → delay → reverb.
- **REQ-5** — `<fx>.on` < 0.5 means bypassed.

## Technical design

### Contract / public interface

```yaml
Effect:        # src/audio/effects/effect.ts
  input: AudioNode
  output: AudioNode
  setBypass(b: boolean): void
  # each concrete effect also exposes bind(bus, prefix) to self-wire its params
  # (ADR-008); not on the interface because Compressor.bind takes index tables.
BypassWrapper: # dry/wet crossfade helper used by all effects
  input / output / dry / wet / processedIn / processedOut: GainNode
  setBypass(b) / setMix(m)
chain(input, fx[], output)  # series-wires input → fx[0] → … → output
```

### Data shapes (registry — synth bus; drum/sampler mirror with a prefix)

```yaml
fx.dist.on/drive/tone/mix          # distortion (tone 200..8000 Hz)
fx.wah.on/rate/depth/q             # auto-wah
fx.phaser.on/rate/depth/feedback/mix
fx.delay.on/time/feedback/mix      # time 0.01..1.5 s, feedback 0..0.95
fx.reverb.on/size/damp/mix
# all *.on default 0 (off); all are no-ops until enabled
prefixes:
  fx.drum.*    : phaser, delay (+ fx.drum.comp, see compressor.md)
  fx.sampler.* : dist, phaser, delay, reverb
```

### Layer touchpoints

```yaml
engine: each effect self-wires via Effect.bind(bus, prefix), e.g.
  this.delay.bind(bus, 'fx.delay')        # on/time/feedback/mix subscribed inside Delay
  this.drumPhaser.bind(bus, 'fx.drum.phaser')   # same class, drum prefix
  this.samplerDist.bind(bus, 'fx.sampler.dist') # same class, sampler prefix
graph: constructor wires the three chains via chain(bus, [..fx], preMaster)
ui: synth FX in app.ts; drum FX in drum-panel.ts; sampler FX in sampler-panel.ts
```

## Scenarios (BDD)

```gherkin
Scenario: Enabling delay crossfades in without a click
  Given fx.delay.on is 0
  When the user sets fx.delay.on to 1
  Then wet ramps from 0 to fx.delay.mix and dry from 1 to (1 - mix), no discontinuity
# pinned by: tests/state/params.test.ts (wiring), e2e/controls.spec.ts

Scenario: Drum and sampler FX are independent of the synth FX (edge)
  Given fx.reverb.on (synth) is 1 and fx.sampler.reverb.on is 0
  Then the synth tail is wet but sampler hits are dry
# pinned by: tests/state/params.test.ts (distinct param ids)
```

## Tests & verification

- `tests/state/params.test.ts` (each effect's params registered + wired),
  `e2e/controls.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- A new effect adds an `Effect` impl + a `BypassWrapper`, its params, and its own
  `bind(bus, prefix)` — then add it to the relevant bus's `chain([...])` list.
