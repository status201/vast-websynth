# Flanger (a worklet comb sweep, on the synth and sampler buses)

```yaml
id: flanger
status: implemented
version: 1
owner: core
related:
  - effects            # the insert-effect contract it implements (WrappedEffect, bypass, drain)
  - fx-slot-picker     # the UI: the middle entry of the Phaser · Flanger · Chorus slot
  - chorus             # its sibling: the other short modulated delay, after it in the chain
  - tempo-lock         # RATE locks to the grid like the phaser's
  - architecture
  - sampler
  - lazy-load-failure  # a worklet that fails to load leaves the instrument playing
source:
  - public/worklets/flanger.js         # the DSP: per-sample circular buffer, log sweep, bounded feedback
  - src/audio/effects/flanger.ts       # Flanger: the boot shell — the wire, the mix, the drain, the trigger
  - src/audio/effects/flanger-live.ts  # the lazy side: module load, splice, param binding
  - src/audio/worklet-module.ts        # loadWorkletModule: once per context and URL, shared with the reverse delay
  - src/audio/effects/fx-chain.ts      # synth + sampler chains, between phaser and chorus
  - src/state/params.ts                # phaserParams + FLANGER_DEFAULTS
  - src/state/tempo-lock.ts            # fx.flanger.rate / fx.sampler.flanger.rate
  - src/state/preset.ts                # the base reset carries fx.flanger.on: 0
  - src/ui/panels/fx-rack.ts           # synth: the Phaser panel's slot
  - src/ui/panels/sampler-panel.ts     # sampler: the PHASER group's slot
  - public/sw.js                       # CORE_ASSETS precaches the worklet
  - src/main.ts                        # the idle warm fetches flanger-live
```

## Background / Why

The synth had every classic modulation effect except a flanger: the jet sweep on
pads, strings, leads and arps. It is a short delay, swept by a slow LFO, mixed
back against the dry signal with feedback, so its notches comb through the
spectrum. The shared panel ([fx-slot-picker](fx-slot-picker.md)) removed the
room problem, which left [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)'s
three constraints, in that order.

**Musical decides the engine.** Web Audio clamps a `DelayNode` that is part of a
cycle to at least one render quantum: 128 frames, about 2.7 ms at 48 kHz. A
native flanger with feedback could never sweep below that. But the jet is the
notches sweeping up through the treble, and the first notch sits at `1/(2τ)`:
2.7 ms puts it at 187 Hz, while 0.25 ms puts it at 2 kHz. A native build would
be a muddy, low-only flanger. So the delay line is an AudioWorklet that reads
its own buffer per sample, and the floor is a choice rather than the spec's.

**Stable and cheap** follow from the worklet's shape. Feedback is clamped and
saturated, so no input at any setting can grow it, and one instance per bus does
about ten operations per sample per channel. Its code is loaded the first time
a flanger is switched on, so a session that never uses it pays nothing at boot
beyond a small shell (about 0.3 kB of the entry chunk).

## Requirements

- **REQ-the-flanger-is-a-worklet-delay-line** — `spliceFlanger` puts one
  `AudioWorkletNode` (`'flanger'` processor) between the wrapper's `processedIn`
  and `processedOut`. Per channel, the processor writes `x + fb · sat(y)` into a
  circular buffer and reads `y` back at a fractional delay, linearly
  interpolated. Its output is `y · √(1 − fb²)` and nothing else: the dry signal
  is the wrapper's, so MIX 0.5 sums dry and delayed equally, which is where the
  notches cut deepest.
  - **Channel-transparent.** The output has as many channels as the input
    (`outputChannelCount` is left unset, so it follows the input). It never
    makes width: the chorus after it does that
    ([chorus](chorus.md) REQ-the-chorus-widens-without-changing-level). On the
    synth bus it sits in the 1-channel stretch, so it runs once per sample.
  - It processes at most two channels, with both buffers allocated at
    construction. Nothing is allocated in `process` ([runtime-performance](runtime-performance.md)
    REQ-no-allocation-in-a-hot-loop).
- **REQ-the-flanger-sweeps-in-pitch** — The delay is
  `FLANGER_MIN_DELAY_S · 2^(FLANGER_SPAN_OCTAVES · depth · tri)`, with `tri` a
  0..1 triangle LFO advanced per sample at RATE. The sweep is exponential in
  time, so the notches move evenly in pitch. A linear sweep crowds the motion
  into the top of its travel, which is the lesson the wah and phaser learned
  ([effects](effects.md) REQ-the-wah-lfo-sweeps-in-cents,
  REQ-the-phaser-sweeps-in-cents). `FLANGER_MIN_DELAY_S` (0.25 ms) is the top of
  the sweep, and DEPTH is how far down it reaches: at depth 1 the delay reaches
  0.25 ms × 2^4.5 ≈ 5.7 ms. At depth 0 it rests at the minimum, a fixed comb.
  Depth and feedback are smoothed per sample inside the processor (a ~10 ms
  one-pole), so a knob turn moves the read head smoothly instead of stepping it
  once per block.
- **REQ-the-flanger-feedback-is-bounded** — For any input at any setting the
  output stays finite and bounded. Rules:
  - feedback is clamped to `[0, FLANGER_MAX_FEEDBACK]` (0.9) inside the
    processor, whatever the param says;
  - the fed-back sample goes through `sat(y) = y / (1 + |y|)` (ADR-010's ladder
    idiom; `sat'(0) = 1`, so quiet signals are linear), so `|written| ≤ |x| + 0.9`;
  - a non-finite input sample (or one beyond ±1e9) is read as 0, and a written value under `1e-20`
    is flushed to 0 so a decaying loop cannot stall on denormals.

  The output scale `√(1 − fb²)` is the broadband power gain of the feedback comb,
  inverted, so turning FB up sharpens the resonance without raising the level.
- **REQ-the-flanger-loads-on-first-use** — Neither the DSP code nor the worklet
  is loaded at boot. The chain holds `Flanger`, a shell that owns only the
  bypass, the mix, the drain and a trigger: `Flanger.bind` watches `<prefix>.on`, and the
  first time it is ≥ 0.5 `ensureLive` imports `flanger-live`, whose
  `spliceFlanger` loads the worklet (`loadFlangerModule`, one promise per
  context, shared by the synth and sampler flangers — through
  `loadWorkletModule` in `src/audio/worklet-module.ts`, which the reverse delay
  shares, [delay-types](delay-types.md)), splices it in and binds
  rate, depth and feedback. Each of those subscriptions fires at once with the
  current value, so the node starts on the knobs as they stand and nothing is
  cached at boot ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request). Measured: the shell adds ~0.3 kB to the
  entry chunk; the eager version added 2.8 kB and broke `check:bundle`'s ceiling.
  - **Offline.** The worklet is precached in `public/sw.js`'s `CORE_ASSETS`,
    and the `flanger-live` chunk joins `main.ts`'s idle warm
    ([pwa-install](pwa-install.md) REQ-service-worker-is-registered), so one online
    visit makes the first switch-on work offline.
- **REQ-an-unloaded-flanger-stays-bypassed** — Until the DSP is spliced in, the
  flanger stays bypassed whatever `<prefix>.on` says: `Flanger.setBypass(false)`
  records the request and applies it only once the node is between `processedIn`
  and `processedOut`. So switching it on mid-load changes nothing audible (the
  dry is at unity), and the bypass crossfade only ever fades in the real wet.
  - **Why not a wire.** The first build connected `processedIn` straight to
    `processedOut` until the splice, so the wet was the dry meanwhile. Once the
    DSP became a lazy chunk, the import outlasted the start of the crossfade, and
    swapping the wire for the delayed signal mid-fade stepped the waveform:
    measured on Blink as one burst 40–72 ms into a take (max step 0.036 against
    0.014 for the bypassed baseline). Gecko happened to splice before the fade.
  - A switch-off before the splice lands is honoured: the flanger stays bypassed.
  - If the import or the load fails, the failure is logged, the flanger stays
    bypassed, and nothing throws into the subscriber that asked (ADR-015). Both
    memos are cleared on failure, so the next switch-on tries again: a cached
    rejection would leave the flanger dead for the session after the network
    came back ([lazy-load-failure](lazy-load-failure.md)
    REQ-retry-reruns-the-whole-gesture's rule). This is an operation, not a
    surface, so it raises no toast (REQ-lazy-scope-is-surfaces-not-operations).
  - Meanwhile the switch reads on while the sound is still dry. A load takes
    milliseconds online, and offline the chunk is warmed
    (REQ-the-flanger-loads-on-first-use).
- **REQ-the-flanger-drains-before-disconnect** — `quiesce` pins the node's
  `feedback` param to 0 (`quiesceParam`). A turn of FB during the drain is held
  and lands on release, and a flanger spliced in mid-drain is quiesced at once.
  `drainSeconds()` is `0.05`: the buffer holds at most ~5.7 ms, so 50 ms of
  silence with the feedback at 0 empties it
  ([effects](effects.md) REQ-a-bypassed-effect-drains-before-disconnect). The
  processor reads a disconnected input as silence and keeps running, so the
  drain happens whichever way the renderer presents the cut.
- **REQ-the-flanger-sits-between-phaser-and-chorus** — Synth chain: `eq → dist →
  wah → phaser → flanger → chorus → delay → reverb → duck`. Sampler chain:
  `eq → dist → phaser → flanger → chorus → delay → reverb → duck`. It sits with
  the modulation it shares a panel with, ahead of the chorus so it stays in the
  synth bus's 1-channel stretch and the chorus remains the one insert that makes
  width. The **drum bus has no flanger**: its phaser is not a slot.
- **REQ-the-flanger-rate-can-be-tempo-locked** — `fx.flanger.rate` and
  `fx.sampler.flanger.rate` are in `TEMPO_LOCKS` (`freq`), resolved through
  `bindTempoLocked`, exactly as the phaser's rate is
  ([tempo-lock](tempo-lock.md) REQ-one-table-declares-lockable-params). A
  flanger swept once per bar or two is a classic, unlike the chorus's shimmer
  ([chorus](chorus.md) REQ-the-chorus-has-no-tempo-lock).
- **REQ-the-flanger-params-default-to-a-no-op** — `phaserParams(prefix, FLANGER_DEFAULTS)`
  registers, at `fx.flanger` and `fx.sampler.flanger` (the phaser's factory: the
  same shape and range, its own defaults):
  - `on`, default 0 (ADR-006);
  - `rate` 0.05–5 Hz (0.2), the phaser's range;
  - `depth` 0–1 (0.7);
  - `feedback` 0–0.9 (0.5);
  - `mix` 0–1 (0.5);
  - `sync`, the tempo lock's division, default free.

  The preset base reset carries `fx.flanger.on: 0`, so a factory preset sets the
  whole sound ([presets](presets.md) REQ-a-factory-preset-sets-the-full-sound).
- **REQ-the-flanger-shares-the-phaser-slot** — The flanger has no panel of its
  own. It is the middle entry of the Phaser slot, in chain order
  **Phaser · Flanger · Chorus**, in the synth rack and the sampler header alike
  ([fx-slot-picker](fx-slot-picker.md)). Its face is RATE · DEPTH · FB · MIX,
  the Phaser's own four, so a view swap reflows nothing.

## Technical design

### Contract / public interface

```yaml
Flanger:         # src/audio/effects/flanger.ts — extends WrappedEffect; in the entry chunk
  constructor(ctx)
  setBypass(b)                       # an un-bypass waits for the splice (REQ-an-unloaded-flanger-stays-bypassed)
  setMix(m)
  bind(bus, prefix)                  # on/mix; the first on -> ensureLive
  ensureLive(bus, prefix): Promise<void>   # import + splice, once; a failure clears the memo
  drainSeconds(): 0.05; quiesce pins feedback to 0
# src/audio/effects/flanger-live.ts — a lazy chunk, warmed on idle
loadFlangerModule(ctx): Promise<void>      # memoised per BaseAudioContext; a failure is forgotten
spliceFlanger(ctx, span, bus, prefix): Promise<FlangerLive>   # load, connect processedIn -> node -> processedOut, bind
FlangerLive: { feedback: AudioParam; hold(on): number }       # what the shell's quiesce needs
FLANGER_MIN_DELAY_S = 0.00025; FLANGER_SPAN_OCTAVES = 4.5; FLANGER_MAX_FEEDBACK = 0.9
```

### Worklet message contract

None: no port messages. The processor reads three k-rate params, each clamped
inside the processor whatever is written:

```yaml
rate:     { default: 0.2, min: 0.01, max: 20 }   # Hz
depth:    { default: 0.7, min: 0,    max: 1 }
feedback: { default: 0,   min: 0,    max: 0.9 }  # 0 until the bind writes it
```

The delay constants live in `flanger.js` and are mirrored as exports of
`effects/flanger-live.ts` for the tests; `tests/audio/flanger-worklet.test.ts` reads
the worklet's own behaviour, so the two cannot drift silently.

### Data shapes

```yaml
fx.flanger.on/rate/depth/feedback/mix/sync           # synth bus
fx.sampler.flanger.on/rate/depth/feedback/mix/sync   # sampler bus
```

### Layer touchpoints & ordering

`createSynthChain` and `createSamplerChain` instantiate the shell between
`phaser` and `chorus` and bind it at its prefix (ADR-008). The Engine is unchanged: the effect
owns its own lazy load, the way `Knob` owns its tempo lock. The UI is the shared
slot of [fx-slot-picker](fx-slot-picker.md), with no new component.

### Persistence

Only the params above, in presets, songs and the session like every insert's.

## Scenarios (BDD)

```gherkin
Scenario: The output stays bounded at the extremes (REQ-the-flanger-feedback-is-bounded)
  Given the processor at depth 1, feedback 0.9 (and a param written at 5)
  When it runs 0.5 s each of full-scale noise, a 0 dBFS square, then silence
  Then every output sample is finite and under a fixed bound
   And the output decays to 0 within the buffer's length plus a few ms after the input stops at feedback 0
# pinned by: tests/audio/flanger-worklet.test.ts

Scenario: Non-finite input does not poison the loop (REQ-the-flanger-feedback-is-bounded, edge)
  Given the processor running a sine at feedback 0.9
  When one block contains NaN and Infinity
  Then every later output sample is finite
# pinned by: tests/audio/flanger-worklet.test.ts

Scenario: The sweep spans the declared range in pitch (REQ-the-flanger-sweeps-in-pitch)
  Given depth 1 and an impulse train
  Then the measured delay ranges from FLANGER_MIN_DELAY_S to FLANGER_MIN_DELAY_S * 2^FLANGER_SPAN_OCTAVES
   And at depth 0 it holds at FLANGER_MIN_DELAY_S
# pinned by: tests/audio/flanger-worklet.test.ts

Scenario: The channel count follows the input (REQ-the-flanger-is-a-worklet-delay-line)
  Given a mono input, then a stereo one
  Then the processor fills one output channel, then two, each from its own buffer
# pinned by: tests/audio/flanger-worklet.test.ts

Scenario: Nothing loads until a flanger is switched on (REQ-the-flanger-loads-on-first-use)
  Given a synth chain bound to a fresh bus
  Then no worklet module has been requested
  When fx.flanger.on goes to 1, and later fx.sampler.flanger.on goes to 1
  Then '/worklets/flanger.js' is added once, and each flanger attaches its own node
# pinned by: tests/audio/effects/flanger.test.ts

Scenario: Before the DSP lands, the flanger stays bypassed (REQ-an-unloaded-flanger-stays-bypassed)
  Given a flanger whose DSP has not loaded
  When fx.flanger.on goes to 1
  Then the wrapper stays bypassed until the node sits between processedIn and processedOut
   And then it un-bypasses, with rate, depth and feedback starting at the knobs as they stand
# pinned by: tests/audio/effects/flanger.test.ts

Scenario: A switch-off before the splice is honoured (REQ-an-unloaded-flanger-stays-bypassed, edge)
  Given fx.flanger.on went to 1 and back to 0 while the DSP was loading
  When the splice lands
  Then the flanger stays bypassed
# pinned by: tests/audio/effects/flanger.test.ts

Scenario: A failed load stays bypassed, throws nowhere and retries next time (REQ-an-unloaded-flanger-stays-bypassed, edge)
  Given addModule rejects
  When fx.flanger.on goes to 1
  Then the bus write returns normally, a warning is logged, and the flanger stays bypassed
  When the network is back and fx.flanger.on goes to 1 again
  Then the flanger loads and splices in
# pinned by: tests/audio/effects/flanger.test.ts

Scenario: Bypass drains the loop (REQ-the-flanger-drains-before-disconnect)
  Given a spliced flanger at feedback 0.6
  When it is quiesced
  Then its feedback param is 0, an FB turn to 0.7 meanwhile is held, and restoring sets 0.7
   And drainSeconds() is 0.05
# pinned by: tests/audio/effects/flanger.test.ts

Scenario: A locked rate follows the tempo (REQ-the-flanger-rate-can-be-tempo-locked)
  Given fx.flanger.sync is a division and transport.bpm changes
  Then the flanger's rate is the division's Hz at the new tempo, and fx.flanger.rate is untouched
# pinned by: tests/audio/effects/flanger.test.ts, tests/ui/tempo-lock.test.ts

Scenario: The flanger sits between phaser and chorus (REQ-the-flanger-sits-between-phaser-and-chorus)
  Then the synth and sampler chains wire phaser -> flanger -> chorus
   And the drum chain has no flanger
# pinned by: tests/audio/effects/flanger.test.ts

Scenario: A legacy song is unchanged (REQ-the-flanger-params-default-to-a-no-op, ADR-006)
  Given a song saved before fx.flanger.* existed
  When it is loaded
  Then fx.flanger.on and fx.sampler.flanger.on are 0 and the flanger is bypassed
# pinned by: tests/state/params.test.ts

Scenario: The slot lists Phaser, Flanger, Chorus (REQ-the-flanger-shares-the-phaser-slot)
  Given the synth rack and the sampler header
  When the slot's menu opens
  Then its entries are Phaser, Flanger, Chorus in that order, and choosing Flanger shows RATE, DEPTH, FB, MIX
# pinned by: tests/ui/fx-slot-picker.test.ts, e2e/chorus.spec.ts

Scenario: The flanger sounds like a flanger, at a steady level (ADR-010)
  Given a held pad and a saw lead, other lanes muted, A/B against a bypassed baseline
  When the flanger is switched on, and depth and feedback are swept to their extremes
  Then the jet sweep is heard, toggling it does not step the level, and nothing runs away or clicks
# pinned by: bench:audio by ear, Blink and Gecko (ADR-010)
```

## Tests & verification

- `tests/audio/flanger-worklet.test.ts`: drives the real processor under Node,
  like `compressor-worklet.test.ts`. Covers boundedness, non-finite input, sweep
  range, channel count and the drain.
- `tests/audio/effects/flanger.test.ts`: the wire and attach, lazy load and its
  failure, quiesce, tempo lock and chain order.
- `tests/state/params.test.ts`: registered, defaults off, the phaser's ranges.
- `tests/state/preset.test.ts`: every factory bank pins `fx.flanger.on` (and,
  should one engage it, `fx.flanger.sync`).
- `tests/ui/fx-slot-picker.test.ts`, `e2e/chorus.spec.ts`: the three-entry slot.
- `npm run bench:audio` in Chromium **and** `--browser firefox`, against a
  bypassed baseline. Sound is signed off by a listener, not by the suite (ADR-010).
  Measured 2026-10-29 at first ship: a held A2-E3-A3 chord on the boot patch,
  reverb and delay off, 10 s takes (`bench/flg-{off,on,max}[.firefox].wav`).
  No bursts, no clipping and no non-finite samples on either engine, after
  the bypass-until-spliced fix (REQ-an-unloaded-flanger-stays-bypassed) removed the
  one burst the wire version left on Blink. The level
  change on enabling is the comb's own: summing a signal with a delayed copy at
  50/50 averages −3 dB across the spectrum, since the notches remove energy.
  That sits inside what effects.md REQ-toggling-an-effect-must-not-step-the-level
  measured for the delay (−5.1 / −1.1 dB).

  ```
                         rms vs off
  defaults (fb 0.5)      -1.3 / -2.6 dB
  depth 1, fb 0.9, 1 Hz  -2.7 / -5.0 dB
                         Blink / Gecko
  ```

  **Signed off by ear 2026-10-29** by the owner, at the shipped constants.

## Open questions / future

- **Through-zero flanging** (the dry delayed to the sweep's centre so the two
  cross) is the tape-flange sound. It is not built: it delays the dry path, which
  the wrapper owns, and should come from a listener asking for it.
- **Negative feedback** (a hollower, odd-harmonic comb) would make FB bipolar.
  Not built, because a bipolar knob is a new control shape for this rack.
- **A stereo flanger** (the two channels' LFOs in antiphase) would make width.
  Not built: the chorus already does that, one slot along.
