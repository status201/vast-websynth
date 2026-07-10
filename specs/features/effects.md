# Insert effects (distortion · wah · phaser · delay · reverb)

```yaml
id: effects
status: implemented
version: 3   # v3: true bypass — bypassed effects disconnect their processed path (ADR-012)
owner: core
related:
  - architecture
  - compressor
  - performance
  - fx-group   # shared header FX-group UI (hides knobs while <fx>.on is off)
source:
  - src/audio/effects/effect.ts        # Effect interface + BypassWrapper
  - src/audio/effects/distortion.ts
  - src/audio/effects/wah.ts
  - src/audio/effects/phaser.ts
  - src/audio/effects/delay.ts
  - src/audio/effects/reverb.ts
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
(`BypassWrapper`). Since v3 the crossfade is followed by a **delayed
disconnect** of the processed path (ADR-012): the Web Audio renderer keeps
computing any subgraph reachable from the destination, so a merely-crossfaded
convolver/oversampled shaper/compressor still burned audio-thread CPU while
"off" — the dominant idle cost on mobile. The same five effects are
instantiated on the synth voice bus; the drum and sampler buses get their own
subsets, so a song can colour each bus independently.

## Requirements

- **REQ-1** — Every effect implements `Effect { input, output, setBypass }`.
- **REQ-2** — (v3, ADR-012) Bypass + mix are a click-free crossfade
  (`BypassWrapper`): wet = `bypassed ? 0 : mix`, dry = `bypassed ? 1 : 1 - mix`,
  ramped. **In addition**, `DISCONNECT_DELAY_MS` (150 ms ≫ the ramp) after
  bypassing, the wrapper disconnects its own two edges (`input → processedIn`,
  `processedOut → wet`) so the processed DSP stops being rendered; un-bypassing
  cancels any pending disconnect, **reconnects first**, then ramps. The wrapper
  never disconnects while wet > 0; rapid toggles are safe (timer cancellation);
  `setMix` while bypassed must not reconnect. Only the wrapper's own edges are
  touched — internal splices like `Compressor.attachWorklet()` survive, even
  when attach happens while bypassed-and-disconnected.
- **REQ-3** — Synth voice bus chain order: distortion → wah → phaser → delay →
  reverb.
- **REQ-4** — Drum bus: [compressor →] phaser → delay → reverb (the compressor
  sits first so it smashes the dry hits, not the FX wash); sampler bus:
  distortion → phaser → delay → reverb.
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
BypassWrapper: # dry/wet crossfade + delayed true-bypass disconnect (ADR-012)
  input / output / dry / wet / processedIn / processedOut: GainNode
  setBypass(b) / setMix(m)
  # bypassed 150ms -> disconnects input→processedIn and processedOut→wet;
  # un-bypass reconnects before ramping. DISCONNECT_DELAY_MS = 150.
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
  fx.drum.*    : phaser, delay, reverb (+ fx.drum.comp, see compressor.md)
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

Scenario: Drum reverb is off by default so legacy songs/presets are unchanged
  Given a song or preset saved before fx.drum.reverb.* existed
  When it is loaded
  Then fx.drum.reverb.on is 0 (bypassed, dry passthrough) and the drums sound as before
# pinned by: tests/state/params.test.ts (defaults), tests/audio/effects/effect-bind.test.ts

Scenario: A bypassed effect stops costing audio-thread CPU (perf, ADR-012)
  Given an effect is enabled and then bypassed
  When the wet ramp has finished (150 ms)
  Then the wrapper has disconnected input→processedIn and processedOut→wet
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: Rapid toggle never disconnects mid-ramp (edge)
  Given an effect is bypassed and re-enabled within 150 ms
  Then no disconnect happens and the crossfade proceeds from the reconnected graph
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: Compressor attach while bypassed-and-disconnected (edge)
  Given a compressor whose worklet attaches after its wrapper already disconnected
  When the compressor is enabled
  Then the wrapper edges reconnect and the spliced worklet path is intact
# pinned by: tests/audio/effects/bypass.test.ts
```

## Tests & verification

- `tests/state/params.test.ts` (each effect's params registered + wired),
  `tests/audio/effects/effect-bind.test.ts` (per-prefix bind independence),
  `tests/audio/effects/bypass.test.ts` (true-bypass disconnect state machine,
  ADR-012), `e2e/controls.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- A new effect adds an `Effect` impl + a `BypassWrapper`, its params, and its own
  `bind(bus, prefix)` — then add it to the relevant bus's `chain([...])` list.
