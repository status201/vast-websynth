# Sidechain ducking (a trigger-keyed ducker on the synth and sampler buses)

```yaml
id: sidechain-ducking
status: implemented
version: 1
owner: core
related:
  - architecture
  - effects          # the insert-chain contract this joins, last
  - drum-machine     # the trigger source — onHit
  - transport        # Clock.onTick supplies the absolute time a hit will sound
  - presets          # fx.duck.* is a patch param and must be pinned
  - runtime-performance
  - mod-matrix       # its "envelope follower off the drum bus" open question
  - fx-patch-decoration
  - fx-group         # the sampler side's DUCK group builder
source:
  - src/audio/effects/ducker.ts          # Ducker + the pure envValueAt
  - src/audio/effects/fx-chain.ts        # chain membership (synth + sampler, last)
  - src/audio/transport/drum-machine.ts  # onHit — the trigger source
  - src/audio/engine.ts                  # wires onHit to the duckers
  - src/state/params.ts                  # duckParams(prefix)
  - src/ui/panels/fx-rack.ts             # the DUCK panel, last in the rack
  - src/ui/panels/sampler-panel.ts       # the DUCK group, last in the sampler's FX row
```

One bus moving out of the way for another. The synth and sampler buses each get a
ducker whose gain envelope is **scheduled from the drum machine's own hits**, at
the absolute `AudioContext` time each hit will sound. There is no worklet, no
detector and no threshold.

## Background / Why

Nothing made room for anything else at `preMaster`, so the pumping of modern
electronic production was not patchable. An envelope follower off the drum bus
costs an analyser read or a worklet ([mod-matrix](mod-matrix.md)). But the drum
machine schedules hits ~100 ms ahead and already knows when each will sound, so the
trigger is free. *Musical*: it follows the pattern (ratchets, probability, fills,
mutes), with no detector lag. *Stable*: the gain law is bounded by construction.
*Cheap*: zero audio-thread DSP, three native nodes per chain, and at most four
`AudioParam` calls per hit (ADR-010). The trade is deliberate: **trigger-keyed
ducking, not audio-detected sidechain compression**. The shape is controllable
rather than program-dependent, the LFOTool/Kickstart choice.

## Requirements

- **REQ-the-duck-is-keyed-by-scheduled-hits** — `DrumMachine` emits `onHit(track,
  when, velocity)` for every hit it plays. `when` is the absolute, swing-adjusted
  time it will sound, so the envelope is scheduled ahead, not chased. No
  `AnalyserNode`, no worklet, no key-input edge.
- **REQ-the-gain-law-is-bounded-by-construction** — The gain is `1 − amount·e(t)`.
  A `ConstantSourceNode` carries `e(t) ∈ [0,1]` into a `depthGain` of `−amount`,
  into `duckGain.gain`, whose intrinsic value stays 1. With `amount ∈ [0,1]` the
  result is provably in `[0,1]`: no clamping, no feedback loop. The envelope is
  scheduled once regardless of depth.
- **REQ-linear-clamp-down-exponential-recovery** — On a qualifying hit at `when`:
  `cancelScheduledValues(when)`, `setValueAtTime(envValueAt(when), when)`,
  `linearRampToValueAtTime(1, when + attack)`, `setTargetAtTime(0, when + attack,
  release)`. That is a cancel anchored first (ADR-027). Firefox has no
  `cancelAndHoldAtTime`, so the current value is computed analytically by the pure,
  exported `envValueAt`.
- **REQ-an-early-duck-trigger-is-ignored** — `forEachActiveHit` sweeps lanes
  outer, ratchets inner, so with source `Any` a later-lane hit can arrive for an
  earlier time. Cancelling for it would erase the later ramp and strand the
  envelope. So `if (when < onset) return`. Both fall in one 16th, so nothing
  audible is lost.
- **REQ-the-resting-duck-state-is-unity** — Every schedule *ends* in
  `setTargetAtTime(0, …)`, a decay to no duck. So a transport stop, a clock dropout
  and a bypass all recover on their own, with no release path and no `onStop`
  wiring. Only a cancel removing a later schedule could strand it, and
  REQ-an-early-duck-trigger-is-ignored prevents that. The ducker holds no state a
  missed tick could corrupt.
- **REQ-a-bypassed-ducker-costs-nothing** — `<prefix>.on` defaults off, which
  leaves existing files unchanged (ADR-006) and lets the other defaults be
  musical. Bypassed, the wrapper disconnects (ADR-012) and scheduling early-returns,
  so there is no main-thread work per hit.
- **REQ-the-duck-key-is-one-track-or-any** — `<prefix>.src` labels are
  `DRUM_TRACKS` plus `'Any'` **appended last** (index 0 = `Kick`). It is
  append-only, since the index is stored. Identity is by *slot*, not model
  ([drum-machine](drum-machine.md) REQ-a-drum-tracks-algorithm-is-selectable).
- **REQ-the-ducker-is-last-in-the-chain** — Last in the synth and sampler chains,
  so tails duck too. The drum bus has none: its own hits are the key.
- **REQ-on-hit-reports-only-sounded-hits** — `onHit` fires inside the
  `forEachActiveHit` callback (muted lanes and failed probability rolls are already
  excluded, and each ratchet sub-hit is its own emission), and from `playFill` and
  `triggerTrack`. `onStep` is **not** the hook: it carries a mapped index and no
  time. **Silence stops the pump**: drum mutes and a solo elsewhere suppress the
  report ([drum-machine](drum-machine.md) REQ-every-sounded-hit-is-reported). A mute
  inside the look-ahead lets at most one scheduled duck through, which decays back.
- **REQ-ducking-adds-no-new-gesture** — Four standard `Knob`s (AMOUNT, ATTACK,
  RELEASE, SRC, the last discrete) and the standard `Switch`. They form a panel last
  in the synth rack and a group last on the Sampler panel, in chain order (ADR-014
  law 4). Panel sizing is [responsive-synth-panels](responsive-synth-panels.md)
  REQ-fx-panels-fit-their-knob-run's. With an even panel count, the patch-cable
  scenery is dormant ([fx-patch-decoration](fx-patch-decoration.md)
  REQ-decoration-is-parity-keyed).

## Technical design

### Contract / public interface

```yaml
Ducker:                                   # src/audio/effects/ducker.ts
  extends: WrappedEffect                  # input / output / setBypass for free
  constructor(ctx)
  onDrumHit(track, when)                  # filtered, then scheduled
  bind(bus, prefix)                       # ADR-008 self-wiring
  # no release()/onStop hook; no setMix (no <prefix>.mix param)

envValueAt(t, onset, startVal, attack, release): number   # exported pure fn
  # t < onset            -> startVal
  # t < onset + attack   -> startVal + (1 - startVal) * (t - onset) / attack
  # otherwise            -> exp(-(t - onset - attack) / release)
  # scalars, so a per-hit call allocates nothing; onset = -Infinity -> 0
DUCK_SRC_ANY = 8                          # the `<prefix>.src` index meaning "any track"

DrumMachine:                              # src/audio/transport/drum-machine.ts
  onHit(fn: (track, when, velocity) => void): () => void   # ListenerSet
```

Internal graph, per `Ducker`:

```
wrap.processedIn ──> duckGain ──> wrap.processedOut      duckGain.gain.value = 1
env (ConstantSourceNode, offset = e(t)) ──> depthGain (−amount) ──> duckGain.gain
```

`env.start()` runs once in the constructor and is never stopped, like the Wah's LFO
(ADR-012 makes an idle instance unreachable).

### Data shapes

```yaml
duckParams(prefix):            # src/state/params.ts
  <prefix>.on:      { min: 0,     max: 1,   default: 0,    step: 1, taper: discrete, labels: [off, on] }
  <prefix>.amount:  { min: 0,     max: 1,   default: 0.7,  format: fmtPct }
  <prefix>.attack:  { min: 0.001, max: 0.1, default: 0.005, format: fmtMs }
  <prefix>.release: { min: 0.02,  max: 1,   default: 0.18, format: fmtMs }
  <prefix>.src:     { min: 0, max: 8, default: 0, step: 1, taper: discrete,
                      labels: [Kick, Snare, C.Hat, O.Hat, L.Tom, M.Tom, H.Tom, Clap, Any] }

prefixes:
  fx.duck          # synth bus  — a PATCH param (rides in presets)
  fx.sampler.duck  # sampler bus — song-level (fx.sampler. is in NON_PATCH_PREFIXES)
```

### Layer touchpoints & ordering

```yaml
audio:
  src/audio/effects/fx-chain.ts  # last in createSynthChain / createSamplerChain
  src/audio/engine.ts            # drums.onHit -> both duckers, wired in init()
ui:
  src/ui/panels/fx-rack.ts / sampler-panel.ts   # appended last, in chain order
  src/ui/onboarding/{help-content,info-badges}.ts  # the fx.duck topic
```

The chains are built in the `Engine` constructor and the machines in `init()`. So
`drums.onHit(...)` is wired in `init()` once both exist.

### Persistence

No new keys and no `SONG_VERSION` bump: additive scalars (ADR-007). `fx.duck.*` is a
patch param, so every factory bank pins `fx.duck.on: 0`
([presets](presets.md) REQ-a-factory-preset-sets-the-full-sound). A bank shipping
with ducking on would sound different depending on the loaded drums.
`tests/state/preset.test.ts` enforces that every bank sets every synth-FX on flag.
The envelope is not persisted; its resting value is unity.

## Scenarios (BDD)

```gherkin
Scenario: A kick hit ducks the synth bus
  Given fx.duck.on is 1 and fx.duck.src is 0 (Kick)
  When the drum machine plays a track-0 hit at time T
  Then the envelope ramps to 1 by T + attack and decays toward 0 with the release constant
  And the resulting gain never leaves [0, 1]
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: A non-key track does not duck
  Given fx.duck.src is 0 (Kick)
  When the drum machine plays a track-3 hit
  Then nothing is scheduled on the envelope
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: Source "Any" ducks on every track
  Given fx.duck.src is 8 (Any)
  When the drum machine plays a hit on any track
  Then the envelope is triggered
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: An out-of-order trigger is ignored (REQ-an-early-duck-trigger-is-ignored, edge)
  Given a hit has been scheduled at time T
  When a hit arrives for a time earlier than T
  Then nothing is cancelled and nothing is scheduled
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: A bypassed ducker schedules nothing (REQ-a-bypassed-ducker-costs-nothing)
  Given fx.duck.on is 0
  When the drum machine plays a key hit
  Then no AudioParam call is made on the envelope
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: A stopped transport recovers to unity unaided (REQ-the-resting-duck-state-is-unity)
  Given the envelope is part-way through a duck
  When the transport stops and no further hits arrive
  Then the decay already scheduled returns it to 0, with no explicit release call
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: A ratcheted step pumps once per sub-hit (REQ-on-hit-reports-only-sounded-hits)
  Given a key-track step with ratchet 4
  When the step plays
  Then onHit fires four times, at four distinct ascending times
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A silent step does not pump (REQ-on-hit-reports-only-sounded-hits)
  Given a key-track step that is muted, or whose probability roll fails
  When the step is swept
  Then onHit does not fire for it
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: Muting the drum lane stops the pump (REQ-on-hit-reports-only-sounded-hits, regression)
  Given ducking engaged and the drums playing
  When the drum lane is muted, or another lane is soloed
  Then the drums fall silent and the synth stops pumping with them
# pinned by: tests/audio/lane-mixer.test.ts, tests/audio/transport/drum-machine.test.ts

Scenario: An existing patch is unaffected (REQ-a-bypassed-ducker-costs-nothing)
  Given a preset or song with no fx.duck keys
  When it is loaded
  Then fx.duck.on and fx.sampler.duck.on are 0 and the sound is unchanged
# pinned by: tests/state/params.test.ts, tests/state/preset.test.ts
```

## Tests & verification

- Unit: `tests/audio/effects/ducker.test.ts`, `tests/audio/transport/drum-machine.test.ts`,
  `tests/audio/effects/{bypass,effect-bind,fx-cost}.test.ts`,
  `tests/state/{params,param-wiring,preset}.test.ts`. E2E: `e2e/controls.spec.ts`;
  `npm run check:params` after a param change.
- **By ear** (ADR-010), A/B against `fx.duck.on: 0` with other lanes muted: does the
  duck land *with* the kick, does the default release sit in the groove, does
  `amount: 1` mute without clicking, does a ratcheted kick stutter coherently.
  The layout is measured across widths by `e2e/responsive-panels.spec.ts`, not at
  one desktop width.

## Open questions / future

- **The audio-detector variant** (a 2-input worklet keyed from
  `drums.trackGains[k]`) would also respond to the sampler's own kick and to live
  drums. It costs a worklet per ducked bus, duplicates `compressor.js`'s detector,
  and its key edge would be the first edge `BypassWrapper` does not own. Argue it on
  its own terms.
- **A tempo-locked grid mode** needs `<prefix>.period` + `.sync`, a `TEMPO_LOCKS`
  entry and sub-tick scheduling (`Clock` emits 16ths, which cannot express 1/8T).
- **Velocity-scaled depth**: `onHit` carries velocity, and the ducker ignores it. It
  wants a listen.
- **Ducking the drum bus from the sampler** would need the sampler to grow the same
  `onHit` surface.
