# Zoetrope (period-locked cycle splicer)

```yaml
id: zoetrope
status: implemented
version: 1
owner: core
related:
  - effects                # the insert-chain contract this joins
  - param-controls         # the bipolar knob / stepper / hold button it introduces
  - compressor             # the worklet-backed-effect template
  - performance-mode       # zoetropeMaxTaps is a per-tier cost knob
  - runtime-performance    # the metering gate + repaint guards
  - render-to-sampler      # the synth-chain tail tap moves here
  - ../decisions/adr-008-components-self-wire-params
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-012-true-bypass-disconnects
source:
  - public/worklets/zoetrope.js          # the DSP (audio thread)
  - src/audio/zoetrope/node.ts           # ZoetropeNode wrapper
  - src/audio/effects/zoetrope.ts        # Zoetrope Effect (BypassWrapper)
  - src/audio/effects/fx-chain.ts        # last member of the synth chain
  - src/audio/engine.ts                  # loadModule/attach, pitch source, drum tap
  - src/audio/polyphony.ts               # pitchHz ConstantSourceNode
  - src/state/params.ts                  # the fx.zoetrope.* defs
  - src/state/perf-mode.ts               # zoetropeMaxTaps per tier
  - src/ui/components/zoetrope-row.ts    # the module UI
  - src/ui/components/cycle-strip.ts     # the cycle-library canvas
  - src/ui/styles/zoetrope.module.css
  - src/ui/app.ts                        # buildFx appends the row + gates telemetry
  - src/ui/studio-api.ts                 # the `zoetrope` facade member
  - src/ui/onboarding/help-content.ts    # the help topic
  - src/ui/onboarding/help-mode.ts       # its badge anchor
```

The sixth synth insert, and the first that is *structural* rather than
tonal. It slices the voice bus at exact cycle boundaries derived from the
sounding pitch, keeps a rolling library of those cycles, and rebuilds the output
by concatenating cycles drawn from anywhere in that history — each resampled to
the current period on the way out. Splices land at matched waveform phase, so no
windowing is needed and pitch stays exact.

## Background / Why

The five existing inserts all shape a signal that arrives intact. Zoetrope
re-assembles it, which makes it capable of sounds nothing else in the rack can
reach — but also makes it opaque: `chaos` at 0.1 sounds locked and at 0.9 sounds
shattered, and a conventional panel gives no hint why.

So the module's centrepiece is the **cycle library strip**: one bar per stored
cycle at its peak amplitude, an accent bar on the cycle being read right now, a
dark bar at the write head. With `chaos` low the playhead visibly bounces
between two or three fixed positions; pushed up it goes everywhere. That single
display teaches the whole instrument, and it costs one throttled post per ~32 ms.

The control set is deliberately small. `scatter`, `chaos` and `smear` are the
character; `mix` is the exit. `sieve` collapses the entire harmonic/noise
feature into one bipolar knob that reads as a tone control, which is what people
actually use it as. `depth` is a **count**, not a continuum — 12 versus 13
cycles is not a distinction anyone hears — so it is a stepped readout rather
than a knob. `freeze` is the performance control, so it is a button you *play*
rather than a switch you set. Everything else lives in an expander that stays
shut.

## Requirements

- **REQ-1** — Zoetrope is the **last** effect of the synth chain:
  `voiceBus → dist → wah → phaser → delay → reverb → zoetrope → preMaster`.
  It is a normal `Effect` around a `BypassWrapper`, so it inherits true bypass
  ([ADR-012](../decisions/adr-012-true-bypass-disconnects.md)) and boots
  bypassed (`fx.zoetrope.on` default 0,
  [ADR-006](../decisions/adr-006-no-op-param-defaults.md)).
- **REQ-2** — The worklet is spliced in **after** `loadModule` via
  `attachWorklet()`, replaying cached setter values — the `compressor` lifecycle
  (compressor.md REQ-5), because `Engine`'s constructor wires the chain
  synchronously.
- **REQ-3** — **Cycle clock.** `Polyphony` owns a `pitchHz`
  `ConstantSourceNode` carrying the Hz of the most recent note-on, written with
  the same `when` + glide ramp as the oscillators. While `fx.zoetrope.pitchlock`
  ≥ 0.5 it is connected to the worklet's a-rate `frequency` param; below 0.5 it
  is disconnected and `frequency` is 0, which makes the worklet fall back to
  zero-crossing detection on its own input.
- **REQ-3c** — **The zero-crossing fallback locks to one period.** A bright or
  polyphonic signal crosses zero many times per cycle, so the raw detector
  chased every partial and stored cycles whose lengths spanned an order of
  magnitude (measured 24–250 samples on a 3-note chord) — which is audible as
  gritty, incoherent splicing. Detection therefore uses **hysteresis** (the
  signal must dip below −5% of the running peak before a rising crossing counts)
  plus a **coherence window** (a candidate length is accepted only if it is
  0.6–1.7× a slow EMA of accepted lengths; a length past 2.5× drops the lock and
  re-acquires). Cycle-length spread on a two-note signal falls from >10× to
  ~2.5×, and the discontinuity rate of a real render from 44/s to 10/s against a
  3/s bypassed baseline.
- **REQ-3b** — **A detection-mode change re-anchors the write cursors.**
  `curStart`/`phase` (pitched) and `lastCross` (zero-crossing) each track a grid
  the *other* mode never advances, so carrying one across the switch records a
  cycle whose start points into long-overwritten history. Both are reset to the
  live write position whenever the mode flips — which is a live path, since the
  pitch-lock chip flips it on demand. A span longer than a quarter of the ring
  buffer is treated the same way (a stale cursor, not a cycle).
- **REQ-4** — **External source.** `fx.zoetrope.source` = 1 records the **drum
  bus** (`drumFx.tail`) with the same cycle boundaries, so drum cycles replay at
  the synth's pitch. The `Engine` owns that cross-chain edge
  (`drumFx.tail → zoetrope.extInput`) so neither chain knows about the other
  ([ADR-008](../decisions/adr-008-components-self-wire-params.md): Engine
  coordinates). While `source` = 0 the effect disconnects `extInput` from the
  node, so the worklet does not write the external store at all.
- **REQ-5** — **True bypass covers the external feed for free.** Web Audio
  renders backwards from the destination, so once the wrapper cuts
  `processedOut → wet` the whole subgraph — the worklet *and* its drum-bus feed —
  goes dormant. Zoetrope must not invent a second disconnect mechanism.
- **REQ-6** — **Freeze suspends the write side only.** `fx.zoetrope.freeze` = 1
  stops recording *and* the boundary detector; the read side keeps splicing, so
  the stored library sustains indefinitely. Every write cursor stops together
  with `writePos`, so they stay mutually consistent and release needs no
  re-anchoring (unlike a mode change — REQ-3b).
- **REQ-6b** — **Every per-cycle gain change is crossfaded, not stepped.** `sub`
  gates or inverts alternate cycles; applied as a bare gain change at the splice
  it is a full-scale discontinuity every other cycle (a real render measured 123
  discontinuity bursts/s against a 3/s bypassed baseline). The alternating gain
  rides the same `smear` crossfade as the audio, which returns it to baseline.
- **REQ-7** — **Bounded output, always.** The output is a linear combination of
  stored samples with bounded coefficients — and the path is feed-forward, so
  denormals cannot accumulate — but per
  [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) "stable" is
  non-negotiable: the processor clamps its output and maps any non-finite value
  to silence, and the cycle period can never be zero (`MIN_CYCLE` floor), so
  `rdInc` can never divide by zero. A boundedness test is mandatory.
- **REQ-8** — **The sieve loop is the only cost that scales.** It is skipped
  entirely while `|sieve| <= 0.001` (the default), and its per-sample work is
  O(taps) *reads* only: tap indices and read positions/increments are resolved
  once per output cycle, never per sample. `taps` is clamped by the perf tier
  (`PERF_PROFILES[tier].zoetropeMaxTaps` — weak 8, medium/strong 16).
- **REQ-9** — **Telemetry is off by default and gated.** The worklet posts
  cycle-library frames only while metering is enabled, and the UI enables it
  only while *all* of: `fx.zoetrope.on` ≥ 0.5, the FX section is not collapsed,
  and the document is visible. The post allocates nothing on the audio thread
  (a `subarray` view, structured-cloned rather than sliced-and-transferred).
- **REQ-10** — **The module collapses while bypassed.** Below
  `fx.zoetrope.on` = 0.5 the module shows only its header (title, chips, switch);
  knobs, controls, strip and expander hide — the same global `.collapsed` class
  mechanism as [fx-group](fx-group.md) REQ-2. Help badges anchor to the module
  **root**, so help stays reachable while bypassed (fx-group.md REQ-5).
- **REQ-11** — **Layout.** The module is a full-width band, a **sibling** of
  `.fxRow` inside `.fxSection` — not a grid cell — so it never disturbs the
  five-effect grid or the patch-decoration parity guard
  ([fx-patch-decoration](fx-patch-decoration.md)). At ≤992px it stacks to
  knobs · controls · strip; at ≤720px the five knobs wrap 3 + 2.
- **REQ-12** — **Pattern mode is reserved, not shipped.** The processor keeps
  its `selectMode` param and its `pattern`/`step` port messages, unbound and
  documented; no `Select` control and no `fx.zoetrope.select` param exists yet
  (a per-step lag lane is an array, which `ParamBus` cannot hold — see *Open
  questions*).

## Technical design

### Contract / public interface

```yaml
ZoetropeNode:   # src/audio/zoetrope/node.ts
  static loadModule(ctx): Promise<void>    # await once per context, before create
  static create(ctx): ZoetropeNode         # sync; 2 inputs, 1 stereo output
  input / output: AudioNode                # both are the worklet node
  frequency: AudioParam                    # a-rate; the cycle clock
  scatter / chaos / smear / sieve / depth / mix / freeze / source /
  selectMode / taps / sub / xfadeFloor: AudioParam    # k-rate
  onCycles: ((m: CycleMeter) => void) | null
  setMetering(on: boolean): void
  clear(): void

Zoetrope (Effect):   # src/audio/effects/zoetrope.ts
  # builds its BypassWrapper + extInput synchronously so Engine can wire in its ctor
  extInput: GainNode                       # Engine connects drumFx.tail here
  attachWorklet(): void                    # splices the node in + replays setters
  setPitchSource(src: ConstantSourceNode): void
  bind(bus, prefix): void                  # self-wires every param (ADR-008)
  onCycles(cb): void
  setBypass / setMix / setScatter / setChaos / setSmear / setSieve /
  setDepth / setFreeze / setSource / setPitchLock / setTaps / setSub /
  setXfadeFloor / setClearOnNote
```

### Data shapes (the registry)

```yaml
fx.zoetrope.on:          { discrete, labels: [off, on], default: 0 }
fx.zoetrope.scatter:     { min: 0,  max: 1,   default: 0 }      # 0 = always newest cycle
fx.zoetrope.chaos:       { min: 0,  max: 1,   default: 0.5 }    # logistic-map r
fx.zoetrope.smear:       { min: 0,  max: 1,   default: 0.25 }   # splice crossfade
fx.zoetrope.sieve:       { min: -1, max: 1,   default: 0 }      # bipolar, centre detent
fx.zoetrope.mix:         { min: 0,  max: 1,   default: 1 }
fx.zoetrope.depth:       { min: 1,  max: 64,  default: 12, step: 1 }
fx.zoetrope.freeze:      { discrete, labels: [off, on], default: 0 }
fx.zoetrope.source:      { discrete, labels: [SELF, DRUMS],  default: 0 }
fx.zoetrope.pitchlock:   { discrete, labels: [off, on], default: 1 }
# --- advanced expander (shut by default) ---
fx.zoetrope.taps:        { min: 2, max: 16,  default: 8,  step: 1 }
fx.zoetrope.sub:         { min: 0, max: 1,   default: 0 }       # 0.5 gates an octave down
fx.zoetrope.xfadeFloor:  { min: 4, max: 256, default: 16, step: 1, unit: smp }
fx.zoetrope.clearOnNote: { discrete, labels: [off, on], default: 0 }
```

`sieve` formats as `NEUTRAL` at 0, `AVG <n>%` below and `RES <n>%` above — the
knob reads as a tone control, which is the point.

### Layer touchpoints & ordering

```yaml
ctor (sync):  createSynthChain builds Zoetrope last -> BypassWrapper wired by chain()
              engine: drumFx.tail.connect(synthFx.fx.zoetrope.extInput)
init (async): await ZoetropeNode.loadModule(ctx)
              synthFx.fx.zoetrope.attachWorklet()          # splice + replay
              (after Polyphony exists) setPitchSource(polyphony.pitchHz)
              synthFx.bind(bus) -> zoetrope.bind(bus, 'fx.zoetrope')
```

`Engine.subscribeParams()` is untouched — the effect self-wires (ADR-008). The
`StudioApi` gains a `zoetrope` member for the same reason `drumComp`/`masterComp`
are there: the cycle-library frames are pushed **upward** from the audio thread,
which `ParamBus` cannot carry
([ADR-009](../decisions/adr-009-ui-depends-on-studio-api-facade.md)).

Because Zoetrope becomes the synth chain's `tail`, the render-to-sampler tap
(`synthFx.tail.connect(bankRenderNode.input)`) now captures it too — correct, and
inert while bypassed. See [render-to-sampler](render-to-sampler.md).

### Persistence

Every control is a `ParamBus` param, so all of it travels in presets and songs
and is reachable from the motion sequencer's param picker and the XY pad — no
allowlist to update.

Deliberately **not** persisted: the cycle library itself (audio-thread state,
dropped on bypass/`clear`), and the metering flag (a UI-visibility concern).

`fx.zoetrope.freeze` **is** a param, so a preset or song saved mid-freeze
reloads frozen. That is the price of making Freeze automatable from the motion
sequencer, which is the most musical thing in the module; it is a knowingly
accepted trade, not an oversight.

### Worklet message contract

```yaml
direction: main -> worklet (node.port.postMessage)
  'clear'                                drop the library (clear-on-note-on)
  { type: 'meter', on: boolean }         enable/disable telemetry (default OFF)
  { type: 'pattern', values: number[] }  RESERVED — pattern mode (REQ-12)
  { type: 'step',  index: number }       RESERVED — pattern mode (REQ-12)

direction: worklet -> main (node.port.onmessage)
payload: { type: 'cycles', peaks: Float32Array, head: int, lag: int,
           count: int, hz: number }
  peaks  oldest -> newest, one peak amplitude per cycle in the REACHABLE window
  count  min(stored cycles, depth) — nothing older than `depth` can ever play,
         so reporting the rest would draw unreachable history
  lag    which cycle is being read now (1 = newest); always <= count
  hz     sampleRate / outPeriod — drives the `tracking N hz` chip in BOTH
         pitch-locked and zero-crossing modes
rate:  ~31 Hz               # 12 × 128 frames ≈ 31 Hz at 48 kHz
when:  only while metering AND count > 0
alloc: none — a subarray view, structured-cloned (never sliced + transferred)
consumer: ZoetropeNode.onCycles -> CycleStrip canvas + the hz chip
params (k-rate AudioParams, NOT messages): everything in the registry above
```

## Visual aids

```
voiceBus ─► dist ─► wah ─► phaser ─► delay ─► reverb ─► zoetrope ─► preMaster
                                                          ▲  │
             drumFx.tail ──────────────────────────────────┘  │ port (cycles, ~31 Hz)
             polyphony.pitchHz ──► frequency (while pitch lock) │
                                                                ▼
                                              CycleStrip  +  `tracking N hz`
```

```
┌───────────────────────────────────────────────────────────────┐
│ ZOETROPE   [pitch lock] [tracking 146 hz]              (● ON) │
│ ───────────────────────────────────────────────────────────── │
│  (scatter) (chaos) (smear) (sieve) (mix)                      │
│  [ Freeze ]  Source[Self|Drums]        Depth [ 12 ]           │
│  ───────────────────────────────────────────────────────────  │
│  Cycle library                                   reading -7   │
│  ▂▅▃▇▄▆▃█▅▃▆▄▇▃▅▄▆█▃▅▆▄▇▃▅▂▆▄█▃▅  ▮                          │
│  oldest                                              now      │
│  ▸ Advanced                                                   │
└───────────────────────────────────────────────────────────────┘
```

## Scenarios (BDD)

```gherkin
Scenario: The module boots collapsed and bypassed
  Given a fresh boot
  Then fx.zoetrope.on is 0
  And the module shows its header and switch but no knobs, controls or strip
# pinned by: tests/ui/zoetrope-row.test.ts, e2e/zoetrope.spec.ts

Scenario: Engaging the module reveals it and starts telemetry
  When the user clicks switch-fx.zoetrope.on
  Then bus.get('fx.zoetrope.on') is 1
  And the knobs, Freeze, Source, Depth and the cycle strip appear
  And the worklet is asked to start metering
# pinned by: tests/ui/zoetrope-row.test.ts, e2e/zoetrope.spec.ts

Scenario: Cycles replay at the locked pitch
  Given frequency is driven at 146 Hz and two cycles are stored
  Then each output cycle lasts sampleRate/146 samples regardless of which
       stored cycle was selected
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: Scatter 0 reads the newest cycle every period
  Given scatter is 0
  Then the reported lag is 1 on every cycle boundary
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: Freeze stops recording (REQ-6)
  Given a filled library
  When freeze goes to 1 and audio keeps arriving
  Then no further cycles are stored, and the read side keeps playing the library
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: The sub octave does not step the gain at a splice (REQ-6b)
  Given sub is at 1 (full polarity inversion of alternate cycles)
  Then no output step exceeds the input's own largest step by much
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: Zero-crossing detection settles on one period (REQ-3c)
  Given two simultaneous notes with several harmonics each, and no pitch signal
  When the library fills
  Then the stored cycle lengths cluster, rather than spanning an order of magnitude
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: Switching detection mode keeps the write cursors live (REQ-3b, edge)
  Given the cycle grid has been running off the pitch signal
  When pitch lock is dropped and detection falls back to zero crossings
  Then both write cursors are re-anchored to the live write position
  And no cycle is recorded spanning long-overwritten history
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: The DSP is bounded under any settings (REQ-7, failure guard)
  Given full-scale input and scatter/chaos/smear/sieve/sub at their extremes
  Then every output sample is finite and within a bounded range
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: Sieve at 0 costs nothing
  Given sieve is 0
  Then the tap-averaging loop never runs
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: Metering is off until asked, then throttled
  Given a running processor that has never been sent a meter message
  Then it posts nothing
  When metering is enabled
  Then it posts a cycles frame about every 12 blocks
# pinned by: tests/audio/zoetrope-worklet.test.ts

Scenario: Bypassing disconnects the worklet and its drum feed (REQ-5, perf)
  Given an engaged Zoetrope with source = DRUMS
  When fx.zoetrope.on goes to 0 and DISCONNECT_DELAY_MS elapses
  Then the wrapper's processedOut -> wet edge is disconnected
  And the worklet subgraph is unreachable from the destination
# pinned by: tests/audio/effects/zoetrope.test.ts

Scenario: Source SELF leaves the external store unwritten
  Given fx.zoetrope.source is 0
  Then extInput is not connected to the worklet node
  When source becomes 1
  Then extInput is connected at input index 1
# pinned by: tests/audio/effects/zoetrope.test.ts

Scenario: Pitch lock off falls back to zero-crossing detection
  When fx.zoetrope.pitchlock goes to 0
  Then the pitch source is disconnected and frequency is 0
  And the worklet still finds cycle boundaries from the input
# pinned by: tests/audio/effects/zoetrope.test.ts, tests/audio/zoetrope-worklet.test.ts

Scenario: Freeze is momentary when held (REQ, interaction)
  When the user presses Freeze and releases within 300 ms
  Then fx.zoetrope.freeze stays 1 (latched)
  When the user presses it and releases after 300 ms
  Then fx.zoetrope.freeze returns to 0
# pinned by: tests/ui/hold-button.test.ts, e2e/zoetrope.spec.ts
```

## Tests & verification

- Worklet DSP, directly: `tests/audio/zoetrope-worklet.test.ts` (stubs worklet
  globals, imports `public/worklets/zoetrope.js`).
- Effect wrapper, bypass + routing: `tests/audio/effects/zoetrope.test.ts`.
- Param registration/defaults: `tests/state/params.test.ts`.
- UI: `tests/ui/zoetrope-row.test.ts`, `tests/ui/cycle-strip.test.ts`, plus the
  shared controls in [param-controls](param-controls.md).
- E2E: `e2e/zoetrope.spec.ts`.
- **Audible**: `npm run bench:audio` renders a take through the real graph so the
  result can be listened to and measured — both defects above were found that
  way and neither was visible to the unit tests. See
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md).
- `npm test` / `npm run e2e` / `npm run typecheck`.
- Dev-bridge assertions: `window.__synth.bus.get('fx.zoetrope.scatter')` (DEV only).
- Manual: engage it, hold a note, raise `scatter` to ~0.5 and sweep `chaos` from
  0.1 to 0.9 — the accent bar must go from bouncing between a few fixed
  positions to landing everywhere. That is the acceptance test for the display.

## Pitfalls (documented behaviour)

- **The mode-change re-anchor** (REQ-3b) is not cosmetic: without it, toggling
  pitch lock leaves a write cursor pointing into history the ring buffer has
  already overwritten, and the next cycles recorded splice in garbage. Freeze,
  by contrast, needs nothing — it stops every cursor together.
- **`depth` is bounded by what is actually stored.** The selector clamps to
  `min(cycCount, depth)` and falls back to the newest cycle if the chosen one
  has aged out of the ring buffer, so a large `depth` on a short note simply
  behaves like a small one.
- **A very low pitch with a large `depth`** can ask for more history than the
  ring buffer holds (~2.7 s at 48 kHz). That is a graceful degradation, not a
  failure — the validity check silently falls back to the newest cycle.
- **The external store is allocated lazily**, on the first block where input 1
  is connected, so a Self-only session holds half the memory.

## Open questions / future

- **Pattern mode** (`Select: Chaos | Pattern`, a 16-step lag lane where you draw
  a lag value per step) is specified in the processor and deliberately unbound
  (REQ-12). Shipping it needs a UI lane, a clock step feed, and somewhere to
  persist an array — `ParamBus` holds scalars only, so that means `PatternStore`
  or a `SongFile` field, i.e. a format bump plus the authoring-dialect, schema
  and MCP mirrors (see
  [evolve-the-song-format](../recipes/evolve-the-song-format.md)).
- A drum/sampler-bus instance is possible (the class takes a prefix like any
  other effect) but pointless without a pitch signal on those buses.
