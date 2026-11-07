# Insert effects (eq · dirt · wah · phaser · flanger · chorus · delay · reverb · duck)

```yaml
id: effects
status: implemented
version: 21
owner: core
related:
  - architecture
  - compressor
  - performance
  - performance-mode     # the maxIrS / oversample tier caps
  - runtime-performance  # the boot-cost + shared-artefact rules
  - fx-group             # shared header FX-group UI (hides knobs while <fx>.on is off)
  - fx-patch-decoration
  - tempo-lock           # the rate/time knobs' grid lock, shared with the LFO
  - sidechain-ducking    # the last chain member (synth + sampler)
  - equalizer            # the member that heads all three chains
  - chorus
  - flanger
  - delay-types          # the delay's TYPE + CHAR
  - dirt-types           # Dirt, the drive effect, and its TYPE
  - fx-slot-picker       # phaser · flanger · chorus share one panel
source:
  - src/audio/effects/effect.ts        # Effect + BypassWrapper + bindBypassMix
  - src/audio/effects/fx-chain.ts      # synth/drum/sampler chain factories
  - src/audio/effects/ducker.ts
  - src/audio/effects/eq.ts
  - src/audio/effects/dirt.ts
  - src/audio/effects/wah.ts
  - src/audio/effects/phaser.ts
  - src/audio/effects/chorus.ts
  - src/audio/effects/flanger.ts       # (+ public/worklets/flanger.js)
  - src/audio/effects/delay.ts
  - src/audio/effects/reverb.ts
  - src/audio/drive-curve.ts            # bucketed WaveShaper curve cache
  - src/audio/transport/drum-machine.ts # the per-track drive, same cache
  - src/state/params.ts
  - src/audio/engine.ts                 # holds synthFx/drumFx/samplerFx; wire + bind
  - src/ui/panels/fx-rack.ts            # the FX row + its panels
  - src/ui/panels/*                     # per-machine FX groups
```

The bypass-able insert effects on the three buses. This spec **owns the chain
order**; other specs link here rather than restating it. The
[compressor](compressor.md) (a worklet) and the DJ filter
([performance](performance.md)) are specified separately.

## Background / Why

Each effect owns a fixed `input → DSP → output` graph wired **once** at setup.
Toggling must never click, so bypass is a dry/wet crossfade (`BypassWrapper`),
followed by a delayed disconnect of the processed path (ADR-012). The renderer
keeps computing anything reachable from the destination, so a crossfaded-only
effect would still burn CPU while "off". Each bus builds its own chain, so a song
colours each bus independently.

## Requirements

- **REQ-every-effect-implements-the-interface** — Every effect implements
  `Effect { input, output, setBypass }`. Insert effects get it by extending
  **`WrappedEffect`**, which owns the `BypassWrapper`. A subclass builds only its
  span from `wrap.processedIn` to `wrap.processedOut` and `bind`s its params.
  `Compressor` overrides `setBypass` to clear its gain-reduction meter.
  **`setMix` is deliberately not on the base**: `bindBypassMix` subscribes
  `${prefix}.mix` only when the effect defines `setMix`. That is how the effects
  with no `.mix` param opt out: Wah, the compressors, the ducker and the EQ.
  Its presence *is* the declaration.
- **REQ-bypass-and-mix-are-a-crossfade** — (ADR-012) Bypass + mix are a crossfade:
  wet = `bypassed ? 0 : mix`, dry = `bypassed ? 1 : 1 - mix`, ramped over
  **`RAMP_BYPASS`** (25 ms). At `DISCONNECT_DELAY_MS` (300 ms, twelve time
  constants, so wet is at −104 dB) after bypassing, the wrapper disconnects its own
  edges in two stages (REQ-a-bypassed-effect-drains-before-disconnect).
  Un-bypassing cancels pending disconnects, **reconnects first**, then ramps. It
  never disconnects while wet > 0. Rapid toggles are safe, and `setMix` while
  bypassed does not reconnect. Only the wrapper's own edges are touched, so
  internal splices (`Compressor.attachWorklet()`) survive even when they attach
  while disconnected.
- **REQ-an-effects-own-controls-ramp** — An effect's own controls (delay time,
  feedback, drive, tone, LFO rate/depth, filter Q, the compressor's setters) ramp
  with the shared `RAMP_SMOOTH` (20 ms, `audio/param-utils.ts`), never a literal.
  They are swept by hand and zipper at anything shorter. Being named makes them
  findable for tuning by ear (ADR-010).
- **REQ-a-bypassed-effect-drains-before-disconnect** (v8) — **A bypassed effect
  drains before it disconnects, so re-enabling it never replays what was frozen
  inside it.** A disconnected `DelayNode` or `ConvolverNode` keeps its state, and
  a song load issues dozens of bypass toggles with feedback up to 0.95
  ([song-mode](song-mode.md) REQ-applying-a-song-is-click-free). So:
  - at `DISCONNECT_DELAY_MS`, disconnect **only** `input → processedIn` and call
    `quiesce(true)` (an internal feedback loop goes to zero);
  - after `drainSeconds()`, disconnect `processedOut → wet`. The subgraph now holds
    silence, so a later reconnect is clean **and immediate**;
  - `setBypass(false)` cancels both timers, reconnects whichever edges are down and
    calls `quiesce(false)` before ramping.

  The drain is paid on the way out, never on the way in. Holding wet at zero after
  a reconnect (ADR-012's sketch) was rejected: it would silence a delay for up to
  2 s on switch-on. A stateless effect overrides neither hook:

  | Effect | `drainSeconds()` | `quiesce(on)` |
  | --- | --- | --- |
  | `Delay` | 2 (the `createDelay(2)` buffer); with a TYPE chosen, the longest connected core's ([delay-types](delay-types.md) REQ-the-delay-drains-every-live-core) | feedback → 0, restored from the last commanded value; the live TYPE core rests its wow/flutter ([delay-types](delay-types.md) REQ-a-type-switch-is-click-free-and-spills) |
  | `Reverb` | `maxIrS`: one IR length of silence clears an FIR convolver | — |
  | `Equalizer` | `EQ_DRAIN_S` = 0.12 ([equalizer](equalizer.md) REQ-the-eq-declares-a-longer-drain) | — |
  | `Phaser` | 0.1 | feedback → 0 |
  | `Flanger` | 0.05 ([flanger](flanger.md) REQ-the-flanger-drains-before-disconnect) | the node's feedback → 0, restored |
  | `Chorus` | 0.05 ([chorus](chorus.md) REQ-the-chorus-drains-briefly) | stops its LFO; a fresh one starts on release |
  | others | `DRAIN_DEFAULT_S` = 0.02 | — |

  `quiesce(true)` writes feedback **directly**, not through `RAMP_SMOOTH`, because
  wet is already at zero and a ramp would leave feedback non-zero into the drain.
  `setFeedback` keeps recording the commanded value while quiesced, so
  `quiesce(false)` restores what the knob says now.
- **REQ-the-synth-chain-order** — Synth voice bus:
  **eq → dirt → wah → phaser → flanger → chorus → delay → reverb → duck**, then
  `synthPan`. The order arrays in `effects/fx-chain.ts` are the code owner.
  - The **eq** heads every chain ([equalizer](equalizer.md) REQ-one-equalizer-per-lane),
    so it shapes what the drive bites on.
  - Phaser, flanger and chorus share one panel ([fx-slot-picker](fx-slot-picker.md)).
    The flanger is channel-transparent.
  - **Channel count:** the synth chain is 1-channel at its head. It goes 2-channel
    after the **chorus** while that is on
    ([chorus](chorus.md) REQ-the-chorus-widens-without-changing-level), and after
    a **PING PONG** delay
    ([delay-types](delay-types.md) REQ-ping-pong-keeps-the-digital-level).
    The reverb is 2-channel. An off-centre sequencer pan splices a per-voice
    stage ahead of the whole chain, making all of it 2-channel while engaged
    ([sequencer](sequencer.md) REQ-the-spread-stage-engages-off-centre, ADR-023).
    No channel count may decide a level.
  - The **duck** is last so the reverb tail ducks too
    ([sidechain-ducking](sidechain-ducking.md) REQ-the-ducker-is-last-in-the-chain).
- **REQ-the-drum-bus-chain-order** — Drum bus: **eq → comp → phaser → delay →
  reverb**. The compressor is first among the effects so it smashes the dry hits,
  not the wash. The EQ ahead of it is deliberate: a highpass before the compressor
  stops the kick pumping the kit. The drum bus has no chorus, no flanger and no
  ducker (its own hits are the key). Sampler bus: **eq → dirt → phaser → flanger →
  chorus → delay → reverb → duck**.
- **REQ-fx-on-below-half-is-bypassed** — `<fx>.on` < 0.5 means bypassed.
- **REQ-the-reverb-ir-bank-is-lazy-and-shared** — (v4) An impulse response is a
  pure function of `(sampleRate, duration)`, and a `ConvolverNode` only reads it.
  So the five bank entries live in one process-wide cache keyed by that pair,
  shared by all three `Reverb`s. Each is generated on **first selection** of its
  size; only the default (index 2, 1.5 s) is built at construction. The perf-tier
  `maxIrS` cap ([performance-mode](performance-mode.md) REQ-weak-tier-reduces-fx-cost)
  applies *before* the key, so capped sizes collapse onto fewer IRs while the bank
  keeps five positions.
- **REQ-drive-curves-are-bucketed-and-memoized** — (v4) DRIVE is a knob, and a
  `WaveShaper` curve is a table with a transcendental per tap. So the amount is
  quantized to `DRIVE_CURVE_STEPS` (64) buckets and cached by `memoizeDriveCurve`
  (`src/audio/drive-curve.ts`). The pre/post gains track the raw amount, so the
  sweep is continuous and only the table steps, which is inaudible (ADR-010).
  Arrays are identity-stable, so callers skip an unchanged `shaper.curve` with
  `!==`. Each caller keeps its own cache and shape. The drum's is anchored at a
  true identity, so `drive 0` stays an exact no-op (ADR-006).
- **REQ-a-bypassed-effect-in-a-song-may-be-deliberate** — (v5) A song is a stage
  setup for a player. An effect saved with `<fx>.on: 0`, or on with `mix: 0`, is
  routinely **staged** for the [XY pad](xy-pad.md), a [motion](motion-sequencer.md)
  lane or the player's hand. So it is not evidence of a mistake and must not be
  "cleaned up" out of a demo, preset or the authoring guide. Likewise an armed
  `arp.on` ([arpeggiator](arpeggiator.md) REQ-saved-arp-on-is-armed-not-broken).
  ADR-006 makes it safe: a staged effect nothing opens is silent.
- **REQ-wah-phaser-and-delay-can-be-tempo-locked** — (v6) The wah, phaser and
  flanger rates and the delay times lock to the tempo through
  [tempo-lock](tempo-lock.md), which owns the behaviour, the UI and `<prefix>.sync`.
  Here: each resolves its rate through `bindTempoLocked`, so `bind` also watches
  `transport.bpm` and a locked effect follows a tempo ramp or MIDI clock. The
  setters are unchanged, so `RAMP_SMOOTH` still applies. `.sync` defaults to
  `free` (ADR-006), but a factory bank that engages one must pin it
  ([presets](presets.md) REQ-a-factory-preset-sets-the-full-sound). A division
  can exceed the delay's registered 1.5 s max. Nothing new clamps it: the UI greys
  the unreachable rows, and the `DelayNode`'s 2 s ceiling holds.
- **REQ-a-reverb-size-change-ducks** (v8) — `setSize` assigns `convolver.buffer`,
  which severs the ringing tail. So the swap uses the mute-then-edit idiom
  (`ModMatrix.patch`): ramp `wrap.processedOut` to 0 over `RAMP_MEDIUM`, swap on
  a `MUTE_SETTLE_MS` (40 ms, ~4 time constants) generation-guarded timer, ramp back. **The identity guard compares
  against the pending target, never against `convolver.buffer`.** A song load
  writes the size twice in one turn (default, then the song's), and a guard on
  the live buffer drops the second write. Any deferred edit owes this rule: guard
  on the intent, not the state the edit has not reached yet.
- **REQ-a-reverb-prepares-its-ir-on-first-use** — A Reverb holds no IR until it
  is first switched on: the constructor assigns no `convolver.buffer`, and a
  `setSize` before then only records the size (no IR built, no duck: nothing has
  rung). The first `setBypass(false)` builds the chosen size and assigns it. A
  buffer assignment prepares the convolution kernel synchronously on the main
  thread, tens of milliseconds for the default IR, and done at construction it
  cost every boot that for each of the three chains, reverbs on or not
  ([runtime-performance](runtime-performance.md) REQ-boot-cost-matches-the-request).
  A reverb that is on at boot pays the same as before, at its enable.
- **REQ-the-wah-lfo-sweeps-in-cents** (v9) — **The wah's LFO drives `bp.detune` in
  cents.** `bp.frequency` is a fixed reference (`midiToHz(75)` = 622.25 Hz)
  written once. A linear-Hz swing drove the bandpass to 0 Hz at depth ≥ 0.415,
  where the biquad degenerates and bursts, and the two engines disagree there.
  The mapping keeps the **top** of every stored sweep where it was; only the
  bottom moves (default 0.4: 22..1222 Hz becomes 317..1222 Hz):

  ```
  depthCents(d) = 1200 * log2(1 + d * 1500 / 622.25)
  ```
- **REQ-the-phaser-sweeps-in-cents** (v13) — Each allpass stage's `detune` carries
  the sweep; its `frequency` is its fixed centre (600, 739, 909, 1119 Hz). Under
  linear Hz, a stage whose centre sat under the swing clamped at 0 Hz and dropped
  out of the phaser for up to 37 % of each cycle. One gain per stage keeps the top
  of each sweep where it was:

  ```
  stageCents(d, fc) = 1200 * log2(1 + d * 1500 / fc)
  ```

  Depth 0 is still no sweep.
- **REQ-toggling-an-effect-must-not-step-the-level** (v10) — A continuous
  crossfade can still step the *level* audibly. The wah has no dry/wet, so
  enabling it replaced the whole signal with a Q ≈ 4 bandpass: about −16 dB in
  10–20 ms, heard as a click (measured, bench:audio, both engines). So:
  - the wah splices a **makeup gain** after its bandpass: `2.5 * sqrt(Q)`, capped
    at ×8 (+18 dB). It tracks `fx.wah.q` through `setQ` with `RAMP_SMOOTH`. That
    removes the step without guaranteeing unity, since the loss depends on the
    spectrum;
  - the crossfade has its own `RAMP_BYPASS` (25 ms) instead of the shorter
    `RAMP_MEDIUM`.
- **REQ-a-fixed-filter-is-a-true-butterworth** — A lowpass or highpass whose
  resonance no control sets (a tone, a damp, a filter at rest) is a true
  Butterworth: `Q = BUTTERWORTH_Q_DB`, 20·log10(√½) ≈ −3.01. Web Audio reads a
  lowpass/highpass `Q` in **dB** ([equalizer](equalizer.md)), so the linear 0.7
  or 0.707 these were written with is a resonant bump instead: +1.7 dB just below
  the cutoff, 3.7 dB above Butterworth at it, and at a 20 kHz "open" cutoff
  +0.75 dB at 15 kHz where Butterworth is within 0.11 dB. The sites: the reverb's
  damp, the chorus tone, Dirt's tone, a drum track's tone, a sampler slot's tone
  at `res` 0 ([sampler](sampler.md) REQ-each-slot-has-a-channel), the sample
  editor's lowpass/highpass edits ([sample-recorder](sample-recorder.md)) and each
  side of the DJ filter while it rests ([performance](performance.md)
  REQ-the-dj-filter-is-a-series-pair). A resonance a control sets keeps its own
  scale: the sampler's `res` rises from this floor, the DJ sweep's Q curve, the
  wah, the synth filter. The delay damp and the ring-mod highpass are Butterworth
  too ([delay-types](delay-types.md), [cross-modulation](cross-modulation.md)).
  Every one of them is built by `butterworth(ctx, type, hz)` in `effects/effect.ts`,
  so the Q cannot be mistyped at a new site.

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
  # bypassed DISCONNECT_DELAY_MS (300) -> disconnects input→processedIn, quiesce(true);
  #   then after drainSeconds() -> disconnects processedOut→wet.
  # un-bypass cancels both timers, reconnects and quiesce(false) before ramping.
WrappedEffect:  # the two hooks a stateful effect overrides
  protected drainSeconds(): number      # default DRAIN_DEFAULT_S (0.02)
  protected quiesce(on: boolean): void  # zero/restore an internal feedback path
chain(input, fx[], output)  # series-wires input → fx[0] → … → output
bindBypassMix(bus, prefix, fx)  # `${prefix}.on` → setBypass; `${prefix}.mix` → setMix when defined
FxChain<E>:    # src/audio/effects/fx-chain.ts — one bus's chain as a unit
  fx: E                      # named members, e.g. drumFx.fx.comp
  wire(input, output) / bind(bus)
  # createSynthChain / createDrumChain / createSamplerChain — explicit factories,
  # each owning its effect order, param prefixes and (drum) the comp ratio table.
```

### Data shapes (registry — synth bus; drum/sampler mirror with a prefix)

```yaml
fx.eq.*                            # equalizer.md
fx.dist.on/drive/tone/mix/type     # Dirt; the ids keep the old name (dirt-types.md)
fx.wah.on/rate/depth/q/sync
fx.phaser.on/rate/depth/feedback/mix/sync
fx.flanger.*                       # flanger.md — phaserParams shape, own defaults
fx.chorus.on/rate/depth/mode/mix   # chorus.md — no sync (REQ-the-chorus-has-no-tempo-lock)
fx.delay.on/time/feedback/mix/sync # time 0.01..1.5 s, feedback 0..0.95
fx.delay.type/char                 # delay-types.md — type 0 = DIGITAL (the no-op)
fx.reverb.on/size/damp/mix
fx.duck.*                          # sidechain-ducking.md
# all *.on default 0 (off); all are no-ops until enabled
# *.sync: one syncParam(prefix) def shared with the LFOs (tempo-lock.md REQ-sync-defaults-to-free);
#   the lockable set is TEMPO_LOCKS in src/state/tempo-lock.ts
prefixes:
  fx.drum.*    : eq, phaser, delay, reverb (+ fx.drum.comp, compressor.md)
  fx.sampler.* : eq, dist, phaser, flanger, chorus, delay, reverb, duck
```

### Layer touchpoints

```yaml
engine: the three chains are built by audio/effects/fx-chain.ts and held as
  synthFx / drumFx / samplerFx; each chain's bind(bus) self-wires its members
  at that chain's prefixes (ADR-008), e.g. inside createDrumChain:
    fx.phaser.bind(bus, 'fx.drum.phaser')     # same class, drum prefix
  `bindBypassMix` opens the shared `.on`/`.mix` pair,
  `bindTempoLocked` (audio/tempo-bind.ts) the `.rate|.time` + `.sync` + BPM trio.
graph: Engine calls synthFx/drumFx/samplerFx .wire(<bus>, preMaster)
ui: synth FX in panels/fx-rack.ts; drum FX in drum-panel.ts; sampler FX in sampler-panel.ts
new effect: an Effect impl + params + bind(bus, prefix), then the chain factory's
  `fx` object AND its order array (recipes/add-an-effect.md)
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
  When DISCONNECT_DELAY_MS (300 ms) has passed
  Then the wrapper has disconnected input→processedIn
   And after the effect's drainSeconds() it has disconnected processedOut→wet too
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: A reverb that is never switched on builds no IR (REQ-a-reverb-prepares-its-ir-on-first-use, regression)
  Given three Reverbs built at boot, all bypassed
  When their size is written while they stay off
  Then no IR is generated and no convolver holds a buffer
  When one is switched on
  Then it builds and holds the size that was written, and only that one
# pinned by: tests/audio/effects/reverb.test.ts

Scenario: Two size writes in one turn land on the second (REQ-a-reverb-size-change-ducks, regression)
  Given the reverb holds the small IR and a song load is applying
  When setSize is called with the default and then with the song's value, in one turn
  Then the IR that lands after the mute window is the song's, not the default
   And the reverse pair still moves it, so the guard has not simply gone away
# pinned by: tests/audio/effects/reverb.test.ts

Scenario: Re-enabling an effect never replays what was frozen in it (REQ-a-bypassed-effect-drains-before-disconnect)
  Given an effect was bypassed while its delay line held audio
  When it is enabled again after the drain has finished
  Then the processed path reconnects holding silence, not the old audio
   And the wet ramp starts immediately — nothing is held back for a tail length
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: A drain in progress is abandoned if the effect comes back (edge)
  Given an effect was bypassed and its input is already disconnected
  When it is enabled again before drainSeconds() has elapsed
  Then both timers are cancelled, both edges are connected, and quiesce is undone
   And the feedback it was holding at zero returns to what the knob says
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: Rapid toggle never disconnects mid-ramp (edge)
  Given an effect is bypassed and re-enabled within DISCONNECT_DELAY_MS
  Then no disconnect happens and the crossfade proceeds from the reconnected graph
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: Compressor attach while bypassed-and-disconnected (edge)
  Given a compressor whose worklet attaches after its wrapper already disconnected
  When the compressor is enabled
  Then the wrapper edges reconnect and the spliced worklet path is intact
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: Enabling the wah does not step the level (REQ-toggling-an-effect-must-not-step-the-level, regression)
  Given a held note with the wah bypassed and every other effect off
  When fx.wah.on goes to 1 and then back to 0
  Then the bus level moves by a few dB, not the 16-19 dB it moved before makeup
   And the crossfade takes RAMP_BYPASS, not RAMP_MEDIUM
# pinned by: tests/audio/effects/wah.test.ts (makeup + constant), bench:audio (the dB)

Scenario: Wah makeup tracks Q and is capped (REQ-toggling-an-effect-must-not-step-the-level, edge)
  Given fx.wah.q is swept from its minimum of 0.5 to its maximum of 20
  Then the makeup gain follows 2.5*sqrt(Q), smoothed with RAMP_SMOOTH
   And it stops at x8, so a narrow band on the centre frequency cannot run away
# pinned by: tests/audio/effects/wah.test.ts

Scenario: The disconnect still lands well after the crossfade (REQ-bypass-and-mix-are-a-crossfade, edge)
  Given the bypass ramp is RAMP_BYPASS
  Then DISCONNECT_DELAY_MS is at least ten of its time constants
   And the wrapper still never disconnects while wet is audible
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: The wah sweep never reaches 0 Hz, at any depth (REQ-the-wah-lfo-sweeps-in-cents, regression)
  Given fx.wah.depth is 1 (the widest sweep the param allows)
  When the LFO is at the bottom of its cycle
  Then the bandpass centre is 622.25 / 2^(depthCents/1200) Hz, still well above 0
   And bp.frequency itself is never written after construction — the sweep is detune
# pinned by: tests/audio/effects/wah.test.ts

Scenario: Raising wah depth past 0.415 no longer steps the output (REQ-the-wah-lfo-sweeps-in-cents, regression)
  Given a wah at depth 0.42, where the old linear-Hz swing clamped at 0 Hz
  Then the sweep is symmetric in octaves about the centre
   And the peak single-sample step stays at the depth-0.35 level, not 10x it
# pinned by: tests/audio/effects/wah.test.ts (contract), bench:audio (the number)

Scenario: A stored song keeps the top of its wah sweep (REQ-the-wah-lfo-sweeps-in-cents, edge)
  Given a demo shipping fx.wah.depth 0.18
  Then the sweep still peaks at 892 Hz, as it did with the linear mapping
   And only the bottom of the sweep moves, from 352 Hz up to 434 Hz
# pinned by: tests/audio/effects/wah.test.ts

Scenario: No phaser stage stalls at 0 Hz, at any depth (REQ-the-phaser-sweeps-in-cents, regression)
  Given a phaser at depth 1 (the widest the param allows)
  When the LFO is at the bottom of its cycle
  Then every stage sits at fc / 2^(stageCents/1200), the lowest still above 150 Hz
   And no stage's frequency is ever written after construction — the sweep is detune
# pinned by: tests/audio/effects/phaser.test.ts

Scenario: A stored song keeps the top of each phaser stage's sweep (REQ-the-phaser-sweeps-in-cents, edge)
  Given a phaser at any depth, including the 0.5 default
  Then each stage still peaks at its centre + depth * 1500 Hz, as it did in linear Hz
   And depth 0 leaves every stage unswept
# pinned by: tests/audio/effects/phaser.test.ts

Scenario: Boot builds one IR, not fifteen (REQ-the-reverb-ir-bank-is-lazy-and-shared, perf)
  Given the three FX chains each construct a Reverb on one context
  Then exactly one impulse response has been generated
  And all three convolvers hold the same buffer object
# pinned by: tests/audio/effects/reverb.test.ts

Scenario: A size is generated once, however long the knob is dragged (REQ-the-reverb-ir-bank-is-lazy-and-shared)
  Given a reverb whose size knob is swept end to end three times
  Then each of the five bank entries was generated exactly once
  And a second reverb selecting the same size generates nothing
# pinned by: tests/audio/effects/reverb.test.ts

Scenario: A tier's IR cap shortens tails without shrinking the bank (REQ-the-reverb-ir-bank-is-lazy-and-shared, edge)
  Given a reverb capped at 1.5 s
  When every size is selected
  Then no IR is longer than 1.5 s, the sizes above the cap share one buffer
  And an uncapped reverb on the same context still gets its full-length IR
# pinned by: tests/audio/effects/reverb.test.ts, tests/audio/effects/fx-cost.test.ts

Scenario: A drive drag reuses curves instead of rebuilding them (REQ-drive-curves-are-bucketed-and-memoized, perf)
  Given 500 drive updates across the full range, repeated
  Then at most DRIVE_CURVE_STEPS curves were built
  And amounts inside one bucket receive the identical array
# pinned by: tests/audio/drive-curve.test.ts

Scenario: A locked effect takes its rate from the tempo (REQ-wah-phaser-and-delay-can-be-tempo-locked)
  Given fx.delay.sync is 1/8 and transport.bpm is 120
  Then the delay runs at 0.25 s, and at 0.5 s once the tempo halves
  And fx.delay.time still holds the value the knob last set
# pinned by: tests/audio/fx-tempo-lock.test.ts, e2e/fx-tempo-lock.spec.ts

Scenario: Free is an exact no-op (REQ-wah-phaser-and-delay-can-be-tempo-locked, ADR-006)
  Given fx.delay.sync is 0
  When the tempo changes
  Then every applied delay time is still the knob's own value
# pinned by: tests/audio/fx-tempo-lock.test.ts

Scenario: A fixed lowpass or highpass is a true Butterworth (REQ-a-fixed-filter-is-a-true-butterworth, regression)
  Given the reverb damp, the chorus tone, Dirt's tone, a drum track's tone, a sampler slot's tone at res 0,
    the editor's lowpass/highpass edit and both DJ filter sides at rest
  Then each one's Q is BUTTERWORTH_Q_DB, read in dB
  And a sampler slot at res 1 and a DJ sweep keep the resonance they had
# pinned by: tests/audio/butterworth-q.test.ts

Scenario: Drive 0 stays an exact no-op after bucketing (REQ-drive-curves-are-bucketed-and-memoized, edge)
  Given the drum machine's identity-anchored curve
  When drive is 0
  Then the builder receives exactly 0 and the curve is the identity line
# pinned by: tests/audio/drive-curve.test.ts
```

## Tests & verification

- `tests/state/params.test.ts`, `tests/audio/effects/{effect-bind,bypass,reverb,wah,phaser,fx-cost}.test.ts`,
  `tests/audio/drive-curve.test.ts`, `tests/audio/fx-tempo-lock.test.ts`, `tests/audio/butterworth-q.test.ts`,
  `e2e/controls.spec.ts`, `e2e/fx-tempo-lock.spec.ts` — `npm test` / `npm run e2e`.
- Sound changes are signed off by ear (ADR-010, [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)).

## Open questions / future

- **A stereo phaser is not built.** The phaser is four allpass stages on one LFO
  and one feedback delay, so it is channel-transparent. A second chain at an LFO
  phase offset would double its DSP on three buses (ADR-010's *cheap*). It would
  also change every shipped sound, so it needs a `width` param defaulting to today
  (ADR-006), splicing on demand like ADR-023, and an ear sign-off.
