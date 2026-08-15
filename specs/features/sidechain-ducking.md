# Sidechain ducking (a trigger-keyed ducker on the synth and sampler buses)

```yaml
id: sidechain-ducking
status: implemented
version: 1
owner: core
related:
  - architecture
  - effects          # the insert-chain contract this joins as a sixth member
  - drum-machine     # the trigger source — REQ-13's onHit was added for this
  - transport        # Clock.onTick supplies the absolute time a hit will sound
  - presets          # fx.duck.* is a patch param and must be pinned (REQ-2b there)
  - runtime-performance
  - mod-matrix       # its "envelope follower off the drum bus" open question
  - fx-patch-decoration  # the sixth panel made it dormant (its REQ-2)
  - fx-group         # the sampler side's DUCK group builder
source:
  - src/audio/effects/ducker.ts          # Ducker + the pure envValueAt
  - src/audio/effects/fx-chain.ts        # chain membership (synth + sampler, last)
  - src/audio/transport/drum-machine.ts  # onHit — the trigger source
  - src/audio/engine.ts                  # wires onHit/onStop to the duckers
  - src/state/params.ts                  # duckParams(prefix)
  - src/ui/app.ts                        # the sixth FX rack panel
  - src/ui/panels/sampler-panel.ts       # the fifth sampler FX group
```

One bus moving out of the way for another. The synth and sampler buses each get a
ducker whose gain envelope is **scheduled from the drum machine's own hits**, at
the absolute `AudioContext` time each hit will sound — not detected from audio
after the fact. No worklet, no detector, no threshold.

## Background / Why

Everything sums at `preMaster` and nothing makes room for anything else, so the
pumping that defines most modern electronic production is not patchable here.
[mod-matrix](mod-matrix.md) already records the gap and defers it: *"an envelope
follower off the drum bus … needs an `AnalyserNode` read or a worklet, so it
carries main-thread cost that has to be argued on its own terms."* That objection
is correct, and this feature answers it by not incurring the cost — the drum
machine schedules its hits ~100 ms ahead and already knows the exact time each one
will sound, so the trigger is free information we were throwing away.

Against [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)'s ordering:
**musical**, because keying off real hits follows the pattern — ratchets,
probability rolls, fills and per-track mute all come along, and there is no
detector lag or threshold to dial; **stable**, because the gain law is bounded by
construction with no feedback path (REQ-2); **cheap**, because there is *zero
audio-thread DSP* — three native nodes per chain and at most four `AudioParam`
calls per hit on a per-tick path.

The deliberate trade: this is **trigger-keyed ducking, not audio-detected
sidechain compression**. It does not respond to the sampler's own kick, to
live-played drums, or to audio content generally. That is the same choice
LFOTool/Kickstart make, and it is what most producers reach for over a true
sidechain compressor — precisely because the shape is controllable rather than
program-dependent. The detector variant is kept as an open question below.

## Requirements

- **REQ-1** — **The duck is keyed by scheduled drum hits, not by an audio
  detector.** `DrumMachine` emits `onHit(track, when, velocity)` for every hit it
  plays; `when` is the absolute `AudioContext` time the hit will sound (already
  swing-adjusted by `Clock`), so the envelope is scheduled ahead rather than
  chased. No `AnalyserNode`, no worklet, no key-input edge.

- **REQ-2** — **The gain law is `1 − amount·e(t)`, bounded by construction.** A
  `ConstantSourceNode` carries the envelope `e(t) ∈ [0,1]`; it feeds a `depthGain`
  of `−amount` into `duckGain.gain`, whose intrinsic value stays 1. Web Audio sums
  the intrinsic value with connected inputs, so with `amount ∈ [0,1]` the result is
  provably in `[0,1]`: no clamping, no feedback loop, nothing that can run away.
  Depth is one gain node, so the envelope is scheduled once regardless of depth.

- **REQ-3** — **The shape is a linear clamp-down and an exponential recovery** —
  what a real compressor makes. On a qualifying hit at `when`:
  `cancelScheduledValues(when)`, `setValueAtTime(envValueAt(when), when)`,
  `linearRampToValueAtTime(1, when + attack)`,
  `setTargetAtTime(0, when + attack, release)`.
  - **`cancelAndHoldAtTime` is not used.** Firefox does not implement it. The
    current envelope value is computed analytically instead by the pure
    `envValueAt`, which is why that function is exported and separately tested.

- **REQ-4** — **A trigger earlier than the last scheduled onset is ignored.**
  `forEachActiveHit` sweeps *lanes outer, ratchet sub-hits inner*, so with source
  `Any` a lane-0 ratchet at `t + 0.5·step` is emitted **before** a lane-3 hit at
  `t`. Cancelling for the earlier time would erase the ramp already scheduled for
  the later one and strand the envelope mid-duck. The guard is
  `if (when < onset) return`. Both hits fall inside one 16th, so nothing audible is
  lost.

- **REQ-5** — **The resting state is unity, and there is no path that strands the
  envelope away from it.** Every schedule *ends* with `setTargetAtTime(0, …)` — a
  decay toward *no duck* — so a transport stop, a clock dropout (after a >0.25 s
  stall `Clock` emits nothing) and a bypass all recover on their own, with no
  explicit release path and no `onStop` wiring. The only thing that could strand a
  duck is a `cancelScheduledValues` that removes a later schedule, which REQ-4's
  guard prevents. Nothing accumulates; the ducker holds no state a missed tick
  could corrupt.

- **REQ-6** — **`<prefix>.on` defaults off, and a bypassed ducker costs nothing.**
  Off is the no-op that leaves every existing preset, song and share link
  unchanged ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)), which is
  what lets the remaining defaults be musical. Under
  [ADR-012](../decisions/adr-012-true-bypass-disconnects.md) the `BypassWrapper`
  disconnects its own two edges once the crossfade settles, so the envelope
  subgraph becomes unreachable from the destination and the renderer skips it.
  Scheduling also early-returns while bypassed, so a bypassed ducker does no
  main-thread work per hit either.

- **REQ-7** — **The key is one drum track, or any of them.** `<prefix>.src` is a
  discrete param whose labels are `DRUM_TRACKS` plus `'Any'` **appended last**;
  index 0 is `Kick`, which is the model track 1 boots on. A discrete index is a
  stored value in every preset and song, so the label array is append-only. Track
  identity is by *slot*, not by model — any track can hold any voice
  ([drum-machine](drum-machine.md) REQ-11), so the label names the lane.

- **REQ-8** — **The ducker is last in the synth and sampler chains; the drum bus
  has none.** Placing it after the reverb means tails duck too, which is the
  sound. The drum bus is deliberately excluded: its own hits are the key, so a
  drum ducker could only duck itself.

- **REQ-9** — **`onHit` reports every sounded hit and only sounded hits.** It fires
  from inside the `forEachActiveHit` callback (so muted lanes and failed
  probability rolls are already excluded, and each ratchet sub-hit is its own
  emission at its own `when`), and from `playFill` and `triggerTrack` so a fill and
  an auditioned pad both pump. Keying off emissions rather than re-reading the
  pattern is what makes it impossible for the duck to fire on a step that did not
  sound.
  - `onStep` is **not** the hook: it carries a performance-mapped step index and no
    time, and exists for the UI playhead.
  - **Silence stops the pump.** Both drum mutes and a solo elsewhere suppress the
    report ([drum-machine](drum-machine.md) REQ-13 v8), so the ducker cannot pump
    to drums nobody can hear. This falls out of keying off *reported* hits rather
    than the grid — the ducker itself knows nothing about mute or solo, which is
    the point of REQ-9. A mute landing inside the clock's look-ahead still lets at
    most one already-scheduled duck through; it decays back to unity by REQ-5.

- **REQ-10** — **The UI adds no new gesture.** Four standard `Knob`s (AMOUNT,
  ATTACK, RELEASE, SRC — the last discrete, following `fx.drum.comp.ratio`) and the
  standard `Switch`, in a sixth `fxPanel` on the synth rack and a fifth `fxGroup`
  on the Sampler panel. Both sit **last**, mirroring chain order (REQ-8). No
  gesture inventory is owed because no interaction is invented —
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 6, precedent before
  invention.
  - **Consequence: the sixth column made equal columns untenable.** `.fxRow`
    widened from `repeat(5, …)` to `repeat(6, …)`, which at 1440 px left each
    panel 220 px against the 242 px a four-knob panel needs — so PHASER and DUCK
    each wrapped a knob onto a second row, and the rack grew 78 px that a
    non-scrolling faceplate does not have. Sizing panels to their knob runs is
    now [responsive-synth-panels](responsive-synth-panels.md) REQ-8; a rack panel
    with four knobs is a shape that spec owns, not this one.
  - **Consequence: the FX patch decoration goes dormant.** Six panels divide the
    ≤992 px 2-column grid evenly, so `buildFx`'s parity guard appends no
    scenery. This is
    [fx-patch-decoration](fx-patch-decoration.md) REQ-2 firing exactly as its own
    open question predicted, not a regression; the component and its unit tests
    are untouched and a seventh effect restores it. The trade was taken
    deliberately — a working effect earns a rack cell ahead of scenery whose job
    was to say "there is room for one more effect here."

## Technical design

### Contract / public interface

```yaml
Ducker:                                   # src/audio/effects/ducker.ts
  extends: WrappedEffect                  # input / output / setBypass for free
  constructor(ctx)
  onDrumHit(track, when)                  # REQ-1/4/7 — filtered, then scheduled
  bind(bus, prefix)                       # ADR-008 self-wiring
  # no release()/onStop hook — REQ-5: every schedule already ends in a decay
  # to no-duck, so stop, dropout and bypass all recover unaided.
  # no setMix — bindBypassMix feature-detects its absence (effects.md REQ-1),
  # exactly as Wah and Compressor do. No <prefix>.mix param exists.

envValueAt(t, onset, startVal, attack, release): number   # exported pure fn, REQ-3
  # t < onset            -> startVal
  # t < onset + attack   -> startVal + (1 - startVal) * (t - onset) / attack
  # otherwise            -> exp(-(t - onset - attack) / release)
  # Scalars, not a state object, so a per-hit call allocates nothing.
  # onset = -Infinity (no hit yet) falls through to exp(-Infinity) = 0.
DUCK_SRC_ANY = 8                          # the `<prefix>.src` index meaning "any track"

DrumMachine:                              # src/audio/transport/drum-machine.ts
  onHit(fn: (track, when, velocity) => void): () => void   # REQ-9, ListenerSet
```

Internal graph, per `Ducker`:

```
wrap.processedIn ──> duckGain ──> wrap.processedOut      duckGain.gain.value = 1
env (ConstantSourceNode, offset = e(t)) ──> depthGain (−amount) ──> duckGain.gain
```

`env.start()` is called once in the constructor and never stopped — the same
arrangement as the `Wah`'s LFO oscillator, and free for the same reason (ADR-012
disconnects make an idle instance unreachable).

### Data shapes

```yaml
duckParams(prefix):            # src/state/params.ts, beside delayParams
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

`.on` off is the no-op (REQ-6), so the other defaults are free to be musical —
the arrangement `delayParams` already uses. These defaults are the compatibility
surface: a default is what every patch predating the param receives.

### Layer touchpoints & ordering

```yaml
state:
  src/state/params.ts            # duckParams(prefix), registered in chain order
audio:
  src/audio/effects/ducker.ts    # the effect + envValueAt
  src/audio/effects/fx-chain.ts  # last in createSynthChain / createSamplerChain
  src/audio/transport/drum-machine.ts  # onHit (ListenerSet, beside onStep)
  src/audio/engine.ts            # drums.onHit -> both duckers
ui:
  src/ui/app.ts                  # sixth fxPanel, last
  src/ui/panels/sampler-panel.ts # fifth fxGroup, last
  src/ui/styles/layout.module.css  # .fxRow repeat(5) -> repeat(6); the panel
                                   # sizing that needed is responsive-synth-panels REQ-8
  src/ui/onboarding/{help-content,info-badges}.ts  # the fx.duck topic
```

Ordering constraints:

- The chains are built in the `Engine` **constructor**; the machines in `init()`.
  A `Ducker` therefore cannot be handed the `DrumMachine` at construction — the
  `Engine` wires `drums.onHit(...)` in `init()` once both exist, following the
  mod-matrix random-source precedent (`clock.onTick` → `setValueAtTime` at the
  tick's own time).
- The order array in each chain factory *is* the signal order, so `duck` goes last
  in both the `fx` object and the array (REQ-8).
- Both the synth rack and the Sampler panel list effect groups in chain order, so
  the new group is appended last in each ([fx-group](fx-group.md) is the shared
  builder for the sampler side).

### Persistence

No new keys and no `SONG_VERSION` bump: these are additive scalar params, which
old files simply lack and receive by default
([ADR-007](../decisions/adr-007-songfile-additive-versioning.md); the precedent is
[tempo-lock](tempo-lock.md) REQ-8). `fx.duck.*` is a patch param and so joins
presets automatically via `bus.snapshot()` — which makes it subject to
[presets](presets.md) REQ-2b: `Presets.apply` is a bare `bus.restore(snap)`, so a
factory preset that omits `fx.duck.on` leaks the previous patch's setting. All
nineteen factory banks pin it, at 0 — a bank shipping with ducking engaged would
make its sound depend on whatever drum pattern happened to be loaded.

That obligation had been stated in a comment in `tests/state/preset.test.ts`
since the tempo-lock work but was only ever enforced for named ids, so
`fx.duck.on` was missing from every bank the day it was registered. The general
rule now has its own test (*sets every synth-FX on flag in every bank*), which is
what caught it.

The envelope itself is deliberately **not** persisted — it is transport-derived
and its resting value is unity (REQ-5).

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

Scenario: An out-of-order trigger is ignored (REQ-4, edge)
  Given a hit has been scheduled at time T
  When a hit arrives for a time earlier than T
  Then nothing is cancelled and nothing is scheduled
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: A bypassed ducker schedules nothing (REQ-6)
  Given fx.duck.on is 0
  When the drum machine plays a key hit
  Then no AudioParam call is made on the envelope
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: A stopped transport recovers to unity unaided (REQ-5)
  Given the envelope is part-way through a duck
  When the transport stops and no further hits arrive
  Then the decay already scheduled returns it to 0, with no explicit release call
# pinned by: tests/audio/effects/ducker.test.ts

Scenario: A ratcheted step pumps once per sub-hit (REQ-9)
  Given a key-track step with ratchet 4
  When the step plays
  Then onHit fires four times, at four distinct ascending times
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A silent step does not pump (REQ-9)
  Given a key-track step that is muted, or whose probability roll fails
  When the step is swept
  Then onHit does not fire for it
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: Muting the drum lane stops the pump (REQ-9, regression)
  Given ducking engaged and the drums playing
  When the drum lane is muted, or another lane is soloed
  Then the drums fall silent and the synth stops pumping with them
# pinned by: tests/audio/lane-mixer.test.ts, tests/audio/transport/drum-machine.test.ts

Scenario: An existing patch is unaffected (REQ-6)
  Given a preset or song saved before this feature existed
  When it is loaded
  Then fx.duck.on and fx.sampler.duck.on are 0 and the sound is unchanged
# pinned by: tests/state/params.test.ts, tests/state/preset.test.ts
```

## Tests & verification

- Unit: `tests/audio/effects/ducker.test.ts` (the scenarios above),
  `tests/audio/transport/drum-machine.test.ts` (`onHit`),
  `tests/audio/effects/{bypass,effect-bind}.test.ts` (the new prefixes join the
  existing per-prefix tables), `tests/audio/effects/fx-cost.test.ts` (perf-tier
  node caps), `tests/state/{params,param-wiring,preset}.test.ts` — `npm test`
- E2E: `e2e/controls.spec.ts` — the sixth FX panel and its knobs — `npm run e2e`
- Typecheck: `npm run typecheck`; `npm run check:params` (ten new params
  republish `public/params.json` + `public/params.md`)
- Dev-bridge: `window.__synth.bus.get('fx.duck.amount')` (DEV only)
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)) — this
  is a *sound* change and a green suite proves nothing about whether it pumps.
  `npm run bench:audio`, A/B against `fx.duck.on: 0`, lanes not under test muted
  ([verify-audio-by-ear](../recipes/verify-audio-by-ear.md)). Four questions: does
  the duck land *with* the kick or behind it; does the default release sit in the
  groove or flam; does `amount: 1` fully mute without clicking on the attack ramp;
  does a ratcheted kick stutter the pump coherently rather than strand it.
- **Bench measurement taken** (not a substitute for the listen above). `Night
  Rider` (125 bpm), `drum.mute: 1` so the drums stop sounding but keep
  triggering, isolating the synth bus: A/B of `fx.duck.on` 0 vs 1 at
  `amount: 0.8`, `release: 0.25`, folded at the beat, gives an instant drop to
  ~0.66 of the dry envelope and a smooth exponential recovery — a **−5.0 dB**
  swing, twice per beat (the demo's kick is on 8ths). That confirms the envelope
  reaches the right node with the right shape through the real graph; it says
  nothing about whether it grooves.
- **By eye** — the six-across FX rack at desktop width, and the 2-column fallback
  below 992 px (three even rows, and the patch-cable filler correctly absent now
  that the panel count is even).
  - **This check was made on a monitor wide enough to hide the defect.** Six
    equal columns need 1546 px before a four-knob panel clears 242 px; below
    that — 1440 px included, which is what CI drives — PHASER and DUCK wrapped a
    knob and the rack stood 78 px taller. "Desktop width" is not one width, and
    an eyeball at one of them is not a sweep. Now measured across widths by
    `e2e/responsive-panels.spec.ts`
    ([responsive-synth-panels](responsive-synth-panels.md) REQ-8).

## Open questions / future

- **The audio-detector variant.** A true sidechain compressor — an
  `AudioWorkletNode` with `numberOfInputs: 2` keyed from `drums.trackGains[k]`,
  with threshold and ratio — would additionally respond to the sampler's own kick
  and to live-played drums. It is deliberately not built: it costs a worklet
  instance per ducked bus, duplicates the detector already in `compressor.js`, and
  its key edge would be the first graph edge the `BypassWrapper` does not own
  (ADR-012 disconnects the wrapper's two edges only). This spec's REQ-1 is the
  cheaper answer to the same musical goal; the detector should be argued on its own
  terms if it is ever wanted.
- **A tempo-locked grid mode.** A `Grid` position on `<prefix>.src` pumping on a
  division regardless of the pattern (the LFOTool default) would need
  `<prefix>.period` + `<prefix>.sync`, a `TEMPO_LOCKS` entry, and sub-tick onset
  scheduling — `Clock` emits 16ths, which cannot express 1/8T. Left out of v1
  because pattern-keyed is the more musical default and the more honest one.
- **Velocity-scaled depth.** `onHit` already carries `velocity`; the ducker ignores
  it, matching Kickstart. Scaling depth by it would make ghost kicks duck less,
  which is either musical or surprising depending on the pattern — it wants a
  listen, not a guess.
- **Ducking the drum bus from the sampler.** The mirror image of REQ-8's exclusion,
  and the only coherent way a drum ducker could exist. Would need the sampler
  machine to grow the same `onHit` surface.
