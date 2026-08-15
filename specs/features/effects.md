# Insert effects (distortion · wah · phaser · delay · reverb)

```yaml
id: effects
status: implemented
version: 6   # v6: REQ-9 — the wah/phaser rates and the delay times can be locked
             #     to the tempo (tempo-lock.md); each bind now also watches
             #     transport.bpm
             # v5: REQ-8 — a bypassed / mix-0 effect in a song can be *staged* for
             #     the player or a motion lane, and is not a defect to clean up
             # v4: lazy+shared reverb IR bank, bucketed drive curves (REQ-6/REQ-7)
             # v3: true bypass — bypassed effects disconnect their processed path (ADR-012)
owner: core
related:
  - architecture
  - compressor
  - performance
  - performance-mode     # the maxIrS / oversample tier caps REQ-6 keys around
  - runtime-performance  # REQ-1/REQ-2 — the boot-cost + shared-artefact rules
  - fx-group   # shared header FX-group UI (hides knobs while <fx>.on is off)
  - fx-patch-decoration  # scenery filling the gap 5 panels leave in the 2-col grid
  - tempo-lock  # v6: the rate/time knobs' grid lock, shared with the LFO
source:
  - src/audio/effects/effect.ts        # Effect + BypassWrapper + bindBypassMix
  - src/audio/effects/fx-chain.ts      # synth/drum/sampler chain factories
  - src/audio/effects/distortion.ts
  - src/audio/effects/wah.ts
  - src/audio/effects/phaser.ts
  - src/audio/effects/delay.ts
  - src/audio/effects/reverb.ts
  - src/audio/drive-curve.ts            # bucketed WaveShaper curve cache (REQ-7)
  - src/audio/transport/drum-machine.ts # the per-track drive, same cache
  - src/state/params.ts
  - src/audio/engine.ts                 # holds synthFx/drumFx/samplerFx; wire + bind
  - src/ui/app.ts                       # the FX row + its panels
  - src/ui/panels/*                     # per-machine FX groups
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

- **REQ-1** — Every effect implements `Effect { input, output, setBypass }`. The six
  insert effects get that surface by extending **`WrappedEffect`**, which owns the
  `BypassWrapper` and exposes `input`, `output` and the default `setBypass`. A
  subclass then contains only its own DSP: build the span from `wrap.processedIn`
  to `wrap.processedOut`, and `bind` its params. `Compressor` overrides `setBypass`
  because it also has to clear its gain-reduction meter.

  **`setMix` is deliberately NOT on the base.** `bindBypassMix` subscribes
  `${prefix}.mix` only when the effect defines `setMix`, and that is the mechanism
  by which Wah and the compressors — which have no `.mix` param registered at all —
  opt out. Hoisting `setMix` onto the base would make every effect claim a mix and
  subscribe a param that does not exist. Effects with a dry/wet declare the
  one-line `setMix` themselves; its presence *is* the declaration.
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
- **REQ-2b** — An effect's own controls (delay time, feedback, drive, tone, LFO
  rate/depth, filter Q, the compressor's setters) are smoothed with the shared
  `RAMP_SMOOTH` constant from `audio/param-utils.ts`, not a literal. The value is
  20 ms — deliberately slower than `RAMP_MEDIUM`, because these are swept by hand
  and zipper audibly at a shorter constant. It had been written out as a bare
  `0.02` at twelve call sites across five effects, which is a tuning constant with
  no name and no single place to change it (ADR-010 calls these dialled by ear, so
  they need to be findable).
- **REQ-3** — Synth voice bus chain order: distortion → wah → phaser → delay →
  reverb.
- **REQ-4** — Drum bus: [compressor →] phaser → delay → reverb (the compressor
  sits first so it smashes the dry hits, not the FX wash); sampler bus:
  distortion → phaser → delay → reverb.
- **REQ-5** — `<fx>.on` < 0.5 means bypassed.
- **REQ-6** — **The reverb IR bank is lazy and shared** (v4). An impulse response
  is a pure function of `(sampleRate, duration)` and a `ConvolverNode` only ever
  *reads* its buffer, so the five bank entries live in one process-wide cache
  keyed by that pair: every `Reverb` — synth, drum and sampler — shares them, and
  each is generated on **first selection** of its size, not up front. Only the
  default size (index 2, 1.5 s) is built at construction. Previously each of the
  three instances rendered all five in the `Engine` constructor: 9.2 s of stereo
  noise apiece, **2.65 M samples and ~10.6 MB** generated synchronously on the
  boot path for sizes most sessions never touch. Selecting a size stays instant
  after its first use, which is what the "don't re-render on knob drags" rule
  always meant. The perf-tier `maxIrS` cap (REQ-11 in
  [performance-mode](performance-mode.md)) is applied *before* the cache key, so
  capped and uncapped tiers never share a buffer and capped sizes simply collapse
  onto fewer distinct IRs — the bank still spans five positions, so `size` keeps
  its meaning.
- **REQ-7** — **Drive curves are bucketed and memoized** (v4). A `WaveShaper`
  curve is a table built with a transcendental per tap, and DRIVE is a *knob* —
  rebuilding per bus tick cost ~60–120 allocations a second (8 kB each at the
  distortion's 2048 taps, plus the drum machine's eight 1024-tap tracks). The
  amount is quantized to `DRIVE_CURVE_STEPS` (64) buckets and the table cached
  per bucket by `memoizeDriveCurve` (`src/audio/drive-curve.ts`); the pre/post
  gains still track the raw amount continuously, so the *sweep* is unchanged and
  only the table is stepped — inaudible in an interpolated saturation table
  (ADR-010). The cache returns identity-stable arrays, so callers skip an
  unchanged `shaper.curve` assignment with a `!==`. Each caller keeps its own
  cache and its own curve *shape*: only the drum's is anchored at a true
  identity, preserving `drive 0` as an exact no-op (ADR-006).

- **REQ-8** — **A bypassed or `mix: 0` effect in a saved song may be deliberate**
  (v5). A song is a *stage setup for a player*, not only a description of what
  sounds by itself: an effect saved with `<fx>.on: 0`, or on with `mix: 0`, is
  routinely **staged** — dialled in and waiting for the [XY pad](xy-pad.md), a
  [motion](motion-sequencer.md) lane or the player's hand to open it up. The same
  reading covers an armed `arp.on` ([arpeggiator](arpeggiator.md) REQ-7). So an
  inert effect setting is **not** evidence of a mistake and must not be
  "cleaned up" out of a demo, a preset or the authoring guide's advice. The
  no-op-default rule (ADR-006) is what makes this safe: a staged effect that
  nothing opens is silent, exactly as if it were absent.
- **REQ-9** — (v6) **The wah and phaser rates and the delay times can be locked
  to the tempo**, through the shared facility [tempo-lock](tempo-lock.md) — which
  owns the behaviour, the UI and the `<prefix>.sync` param shape. What belongs
  here is only what it means for an effect:
  - Each of `Wah`/`Phaser`/`Delay` resolves its rate through `bindTempoLocked`
    instead of a bare `bus.subscribe`, so its `bind` now also watches
    `transport.bpm`. A locked effect therefore tracks a tempo ramp or an incoming
    MIDI clock ([midi-clock-sync](midi-clock-sync.md)) with nothing else touched.
  - The **setters are unchanged**, so REQ-2b's `RAMP_SMOOTH` smoothing still
    applies: the lock changes *what* value is applied, never *how*.
  - `<prefix>.sync` defaults to `free`, an exact no-op (ADR-006) — but the
    factory banks that **engage** one of these effects must pin it, or an engaged
    effect inherits the previous patch's division ([presets](presets.md) REQ-2b).
  - The delay is the one whose range a division can leave (`1/1` is 4 s at
    60 BPM against a registered 1.5 s max). Nothing new clamps it: the UI greys
    the unreachable rows and the `DelayNode`'s own pre-existing 2 s ceiling is
    what holds, so no stored patch changes how it sounds.

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
bindBypassMix(bus, prefix, fx)  # the shared `${prefix}.on` → setBypass and
                                # `${prefix}.mix` → setMix pair (setMix optional:
                                # the Wah has no dry/wet, so it skips .mix)
FxChain<E>:    # src/audio/effects/fx-chain.ts — one bus's chain as a unit
  fx: E                      # named members, e.g. drumFx.fx.comp
  tail: AudioNode            # last effect's output (the bank-render tap point)
  wire(input, output) / bind(bus)
  # createSynthChain / createDrumChain / createSamplerChain — explicit factories,
  # each owning its effect order, param prefixes and (drum) the comp ratio table.
```

### Data shapes (registry — synth bus; drum/sampler mirror with a prefix)

```yaml
fx.dist.on/drive/tone/mix          # distortion (tone 200..8000 Hz)
fx.wah.on/rate/depth/q/sync        # auto-wah                    (v6: sync)
fx.phaser.on/rate/depth/feedback/mix/sync                      # (v6: sync)
fx.delay.on/time/feedback/mix/sync # time 0.01..1.5 s, feedback 0..0.95 (v6: sync)
fx.reverb.on/size/damp/mix
# all *.on default 0 (off); all are no-ops until enabled
# *.sync: discrete, labels SYNC_LABELS, range 0..18, default 0 = free — the
#   tempo lock (REQ-9, tempo-lock.md REQ-8). One `syncParam(prefix)` def, shared
#   with the LFOs, so the nine locks cannot drift apart.
prefixes:
  fx.drum.*    : phaser, delay, reverb (+ fx.drum.comp, see compressor.md)
  fx.sampler.* : dist, phaser, delay, reverb
```

### Layer touchpoints

```yaml
engine: the three chains are built by audio/effects/fx-chain.ts and held as
  synthFx / drumFx / samplerFx; each chain's bind(bus) self-wires its members
  at that chain's prefixes (ADR-008), e.g. inside createDrumChain:
    fx.phaser.bind(bus, 'fx.drum.phaser')     # same class, drum prefix
    fx.delay.bind(bus, 'fx.drum.delay')
  and `bindBypassMix` (effects/effect.ts) opens the shared `.on`/`.mix` pair,
  `bindTempoLocked` (audio/tempo-bind.ts) the `.rate|.time` + `.sync` + BPM trio.
graph: Engine calls synthFx/drumFx/samplerFx .wire(<bus>, preMaster)
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

Scenario: Boot builds one IR, not fifteen (REQ-6, perf)
  Given the three FX chains each construct a Reverb on one context
  Then exactly one impulse response has been generated
  And all three convolvers hold the same buffer object
# pinned by: tests/audio/effects/reverb.test.ts

Scenario: A size is generated once, however long the knob is dragged (REQ-6)
  Given a reverb whose size knob is swept end to end three times
  Then each of the five bank entries was generated exactly once
  And a second reverb selecting the same size generates nothing
# pinned by: tests/audio/effects/reverb.test.ts

Scenario: A tier's IR cap shortens tails without shrinking the bank (REQ-6, edge)
  Given a reverb capped at 1.5 s
  When every size is selected
  Then no IR is longer than 1.5 s, the sizes above the cap share one buffer
  And an uncapped reverb on the same context still gets its full-length IR
# pinned by: tests/audio/effects/reverb.test.ts, tests/audio/effects/fx-cost.test.ts

Scenario: A drive drag reuses curves instead of rebuilding them (REQ-7, perf)
  Given 500 drive updates across the full range, repeated
  Then at most DRIVE_CURVE_STEPS curves were built
  And amounts inside one bucket receive the identical array
# pinned by: tests/audio/drive-curve.test.ts

Scenario: A locked effect takes its rate from the tempo (v6, REQ-9)
  Given fx.delay.sync is 1/8 and transport.bpm is 120
  Then the delay runs at 0.25 s, and at 0.5 s once the tempo halves
  And fx.delay.time still holds the value the knob last set
# pinned by: tests/audio/fx-tempo-lock.test.ts, e2e/fx-tempo-lock.spec.ts

Scenario: Free is an exact no-op (v6, REQ-9, ADR-006)
  Given fx.delay.sync is 0
  When the tempo changes
  Then every applied delay time is still the knob's own value
# pinned by: tests/audio/fx-tempo-lock.test.ts

Scenario: Drive 0 stays an exact no-op after bucketing (REQ-7, edge)
  Given the drum machine's identity-anchored curve
  When drive is 0
  Then the builder receives exactly 0 and the curve is the identity line
# pinned by: tests/audio/drive-curve.test.ts
```

## Tests & verification

- `tests/state/params.test.ts` (each effect's params registered + wired),
  `tests/audio/effects/effect-bind.test.ts` (per-prefix bind independence),
  `tests/audio/effects/bypass.test.ts` (true-bypass disconnect state machine,
  ADR-012), `tests/audio/effects/reverb.test.ts` (the lazy/shared IR bank),
  `tests/audio/drive-curve.test.ts` (bucketed curve cache),
  `tests/audio/effects/fx-cost.test.ts` (perf-tier caps), `e2e/controls.spec.ts`,
  `tests/audio/fx-tempo-lock.test.ts` + `e2e/fx-tempo-lock.spec.ts` (v6, REQ-9).
- `npm test` / `npm run e2e`.

## Open questions / future

- A new effect adds an `Effect` impl + a `BypassWrapper`, its params, and its own
  `bind(bus, prefix)` — then add it to the relevant chain factory in
  `effects/fx-chain.ts` (its `fx` object **and** its order array).

- **A stereo phaser and a ping-pong delay are the obvious width upgrade, and
  neither is built.** Recorded here so the absence reads as a decision rather
  than an oversight, since the specs have twice described these as stereo when
  they are not ([scope](scope.md) v9 and v10 both removed such a claim). As
  shipped: the **phaser** is four allpass biquads driven by *one* LFO through
  *one* feedback delay, and the **delay** is a single `DelayNode` with a damped
  feedback loop and no cross-feed. Both are channel-transparent — they carry a
  stereo image, they never make one. Only the **reverb** (2-channel decorrelated
  IR) does that. The upgrade would be a second allpass chain at an LFO phase
  offset, and a delay whose two taps cross-feed. What it costs:
  - **Twice the DSP per effect, in three chains each** (synth / drum / sampler),
    always-on for whichever instances are un-bypassed. [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)'s
    *cheap* is the standing objection; [ADR-012](../decisions/adr-012-true-bypass-disconnects.md)
    softens it (a bypassed effect is disconnected, so idle cost stays nil) but
    an enabled one doubles.
  - **It changes how every shipped preset and demo sounds.** A width change is
    not a no-op default ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)),
    so it either needs a `width`/`spread` param defaulting to today's mono
    behaviour, or it is a deliberate break. The param is the honest route.
  - **It cannot be signed off by a green suite.** This is a *sound* change, so
    [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) and
    [verify-audio-by-ear](../recipes/verify-audio-by-ear.md) apply: render
    through the real graph, A/B a bypassed baseline, mute the lanes not under
    test, and have a human listen. That, not the DSP, is the reason this is a
    feature rather than a patch.
