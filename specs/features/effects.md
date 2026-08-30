# Insert effects (distortion · wah · phaser · delay · reverb · duck)

```yaml
id: effects
status: implemented
version: 10  # v10: REQ-12 — the wah gets makeup gain, and the bypass crossfade
             #      gets its own RAMP_BYPASS constant: toggling an effect was a
             #      16-19 dB level step in 10-20 ms — continuous samples, but
             #      plainly a click, and the wah was simply mixed too quiet
             # v9: REQ-11 — the wah sweeps in CENTS, not Hz. A linear Hz swing
             #     around a 622 Hz centre reaches 0 Hz at depth 0.415 and the
             #     bandpass degenerates there — measured; latent in nine demos
             #     that stage the wah at 0.4-0.6 for a player to open
             # v8: REQ-2c — a bypassed effect DRAINS before it disconnects, so
             #     re-enabling one can never replay the audio frozen inside it
             #     (ADR-012's accepted risk, discharged — it bit on a demo load)
             # v7: REQ-3/REQ-4 — a ducker joins the synth and sampler chains, last
             #     in both, so the reverb tail ducks too (sidechain-ducking.md)
             # v6: REQ-9 — the wah/phaser rates and the delay times can be locked
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
  - fx-patch-decoration  # v7: dormant now that six panels divide the grid evenly
  - tempo-lock  # v6: the rate/time knobs' grid lock, shared with the LFO
  - sidechain-ducking    # v7: the sixth chain member (synth + sampler, last)
source:
  - src/audio/effects/effect.ts        # Effect + BypassWrapper + bindBypassMix
  - src/audio/effects/fx-chain.ts      # synth/drum/sampler chain factories
  - src/audio/effects/ducker.ts        # v7: the trigger-keyed ducker
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
(`BypassWrapper`) — which buys sample continuity but not, on its own, *loudness*
continuity: an effect that changes the level a lot in a few milliseconds clicks
anyway, which is REQ-12. Since v3 the crossfade is followed by a **delayed
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
  ramped over **`RAMP_BYPASS`** (25 ms, v10 — see REQ-12; it was `RAMP_MEDIUM`,
  the *shortest* constant in the audio layer, for a swap that moves more level
  than any single knob does). **In addition**, `DISCONNECT_DELAY_MS` (300 ms, ≫
  the ramp — twelve time constants, so wet is at −104 dB) after
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
- **REQ-2c** (v8) — **A bypassed effect drains before it disconnects, so
  re-enabling one can never replay what was frozen inside it.** Disconnecting a
  subgraph stops the renderer pulling it, which does not clear it: a `DelayNode`'s
  ring buffer and a `ConvolverNode`'s tail keep the last audio that went through
  them, indefinitely. Reconnecting resumes from that state, and the crossfade
  obligingly ramps it up. [ADR-012](../decisions/adr-012-true-bypass-disconnects.md)
  foresaw this and accepted it "at wet-mix level, under a fresh ramp, **after a
  deliberate user toggle**" — but a song load issues dozens of bypass toggles that
  no user made ([song-mode](song-mode.md) REQ-17), and with `fx.delay.feedback` up
  to 0.95 the remnant recirculates rather than decaying. It was heard as a burst of
  the *previous* song on clicking a demo, with the transport stopped.

  So the disconnect becomes two stages:
  - at `DISCONNECT_DELAY_MS` (unchanged), disconnect **only** `input → processedIn`
    and call `quiesce(true)` — no new signal enters, and an effect with an internal
    feedback loop zeroes it so its memory can actually empty;
  - after `drainSeconds()`, disconnect `processedOut → wet`. The subgraph has been
    rendering silence into itself for that long, so what it holds *is* silence and
    a later reconnect is clean **and immediate**.
  - `setBypass(false)` cancels both timers, reconnects whichever edges are down and
    calls `quiesce(false)` before ramping.

  ADR-012's saving is intact — the DSP costs one bounded drain after a bypass
  instead of running forever. **Not** the fix ADR-012 sketched ("holding wet at
  zero for one tail-length after reconnect"): that pays the tail on the way *in*,
  so switching a delay on would be silent for up to 2 s, which is worse than the
  bug. Drain on the way out and the user never waits.

  The declarations, following the same "its presence *is* the declaration" idiom
  as `setMix` in REQ-1 — a stateless effect overrides neither:

  | Effect | `drainSeconds()` | `quiesce(on)` |
  | --- | --- | --- |
  | `Delay` | 2 — the `createDelay(2)` buffer; silence in for that long is silence throughout | feedback → 0, restored from the last commanded value |
  | `Reverb` | `maxIrS` — an FIR convolver is cleared exactly by one IR length of silence | — |
  | `Phaser` | 0.1 | feedback → 0 (a 0.05 s loop; it decays in ~25 ms regardless) |
  | others | `DRAIN_DEFAULT_S` = 0.02 | — |

  `quiesce(true)` writes the feedback gain **directly**, not through `RAMP_SMOOTH`:
  the wet path is already at zero by then, so there is nothing for a step to be
  heard in, and a ramp would leave feedback still non-zero for the first part of
  the drain. `setFeedback` keeps recording the commanded value while quiesced so
  `quiesce(false)` restores what the knob says, not what it said at bypass time.

- **REQ-3** — Synth voice bus chain order: distortion → wah → phaser → delay →
  reverb → duck.
  - (v7) The **duck** is last so the reverb tail ducks with everything else,
    which is the sound it exists to make. It is the one member that is not a
    self-contained DSP span: its envelope is scheduled from drum-machine hits, so
    its behaviour is specified in
    [sidechain-ducking](sidechain-ducking.md) REQ-8 rather than here.
- **REQ-4** — Drum bus: [compressor →] phaser → delay → reverb (the compressor
  sits first so it smashes the dry hits, not the FX wash); sampler bus:
  distortion → phaser → delay → reverb → duck.
  - (v7) The drum bus deliberately has **no** ducker: its own hits are the key, so
    one there could only duck itself
    ([sidechain-ducking](sidechain-ducking.md) REQ-8).
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

- **REQ-10** (v8) — **A reverb size change ducks across the IR swap.**
  `setSize` assigns `convolver.buffer`, which resets the node's state and severs
  whatever tail it was ringing — heard when a song load changes the size under a
  tail that is still sounding ([song-mode](song-mode.md) REQ-17), and it fires
  *twice* per load (the reset to the default index, then the song's). The swap is
  therefore wrapped in the mute-then-edit idiom `ModMatrix.patch` already uses:
  ramp `wrap.processedOut` to 0 over `RAMP_MEDIUM`, swap on a 40 ms
  generation-guarded timer, ramp back. `IR_DURATIONS` is coarse enough that
  sweeping the knob crosses few boundaries. The tail still restarts — that is what
  changing the size *means*; what goes is the step at the seam.

  **The identity guard compares against the pending target, never against
  `convolver.buffer`.** Deferring the swap makes the live buffer stale for the
  whole window, and a song load writes this param *twice in one turn* (REQ-17 of
  [song-mode](song-mode.md)): the default, then the song's. Guarding on the live
  buffer, the second write saw the value the first had not applied yet, concluded
  it was already there and returned **without superseding the pending swap** — so
  the default landed 40 ms later. Shipped and reported from the field: two demos
  asking for 11 % played at the 60 % default, and nudging the knob by one percent
  made the reverb *smaller*, because that write finally did differ from the live
  buffer. It only bit when the previous song had left the song's own IR in place,
  which is what made it intermittent. Any deferred edit owes the same rule: the
  guard reads the intent, not the state the edit has not reached yet.

- **REQ-11** (v9) — **The wah's LFO sweeps its bandpass in cents, not in Hz.**
  `Wah` modulated `bp.frequency` with a gain of `depth * 1500` **linear Hz**
  around a centre of `midiToHz(75)` = 622.25 Hz. A linear swing around a fixed
  centre is not a musical sweep (ADR-005: the same "+200 Hz" is an octave down low
  and nothing up high) and, worse, it runs off the end of the parameter: at
  `depth >= 622.25 / 1500 = 0.415` the LFO trough drives the computed
  `bp.frequency` to zero or below, where the `AudioParam` clamps at 0 and the RBJ
  bandpass degenerates — `alpha = sin(w0)/2Q = 0`, so the numerator is all zeros
  over a denominator with a double pole at z = 1.

  Measured through the real graph, a sine-sum source into the real `Wah` +
  `BypassWrapper`, peak single-sample step in the steady (non-toggling) region:

  ```
  depth   bp.frequency trough    Blink      Gecko    bursts/s
  0.35            97 Hz         0.0063     0.0063       0
  0.40            22 Hz         0.0077     0.0076       0     <- the shipped default
  0.42            -8 Hz         0.0569     0.0849     1.0     <- clamped at 0
  0.45           -53 Hz         0.0737     0.0752     1.0
  0.60          -278 Hz         0.0606     0.0548     1.0
  ```

  A ~10x jump in discontinuity size, and the burst detector
  ([verify-audio-by-ear](../recipes/verify-audio-by-ear.md)) goes from silent to
  firing, the moment the trough crosses zero. Both engines break, and they break
  *differently* — 0.0569 against 0.0849 at the onset — because a degenerate biquad
  is exactly where two implementations stop agreeing. Under the cents mapping they
  match to three decimals at every depth.

  No shipped demo plays the wah over the cliff today: only `Bunk` (0.11) and
  `Run Away` (0.35) have `fx.wah.on: 1`. It is **latent**, and REQ-8 is why that
  still matters — nine demos *stage* the wah at 0.4-0.6 with `on: 0` (`apex-twin`
  and `hacienda_neworder` at 0.6; `Elegy`, `First_Light`, `Maison`, `Night_Rider`,
  `Slouch`, `Titulaer`, `fat` at 0.4), waiting for a lane or the player's hand to
  open it, and opening one is what crosses the cliff. `fx.wah.depth` also
  **defaults to 0.4**, two percent under it, so nudging the knob up on any patch
  falls off.

  So the LFO drives **`bp.detune`**, in cents, and `bp.frequency` is a fixed
  reference written once at construction and never again — the same conclusion
  [performance](performance.md) REQ-10 reached for the DJ filter, for the same
  reason: cents *are* log-frequency, so a linear swing in cents is the sweep the
  ear expects, and `frequency * 2^(detune/1200)` can never reach zero.

  The depth mapping is chosen to **leave the top of every existing sweep exactly
  where it was**, so no stored song changes its brightest point:

  ```
  depthCents(d) = 1200 * log2(1 + d * 1500 / 622.25)
  ```

  which is the cents equivalent of the old upward excursion. Only the bottom
  moves, from a dive toward 0 Hz to the symmetric reflection of the top:
  at the default 0.4, `22 .. 1222 Hz` becomes `317 .. 1222 Hz`; at Around's 0.18,
  `352 .. 892 Hz` becomes `434 .. 892 Hz`.


- **REQ-12** (v10) — **Toggling an effect must not step the level, and the wah's
  bandpass carries makeup gain so that it does not.** REQ-2 has claimed since v1
  that the crossfade means bypass "never clicks". It does prevent a
  *discontinuity* — measured, the waveform is continuous to the float32 noise
  floor on both engines — but it says nothing about how much the level moves, or
  how fast. Measured through the real graph, one held A2, transport stopped, no
  other effect in the chain:

  ```
                       enable            bypass
  wah (Around's Q 3.9)  -13.0 / -15.5 dB  +19.0 / +18.6 dB   in 10-20 ms
  delay (mix 0.3)        -5.1 /  -1.1 dB   +6.8 /  +5.8 dB
                        Blink /  Gecko    Blink /  Gecko
  ```

  A 19 dB jump in 10 ms is heard as a click however smooth the samples are, and
  it is why the wah is the effect people report: it is the **only** one with no
  `setMix` (REQ-1), so `initialMix = 1`, `update()` computes `dry = 0`, and
  enabling it does not blend a wah in — it replaces the entire signal with a
  Q ≈ 4 bandpass that has no output compensation. Every other insert either
  blends (phaser 0.5, delay 0.3, reverb 0.25) or is broadband (distortion).

  Two changes, because they fix different halves:

  - **The wah splices a makeup gain** between its bandpass and
    `wrap.processedOut`. A constant-peak-gain bandpass passes a share of a
    broadband signal proportional to its bandwidth `f0 / Q`, so the loss goes as
    `1/sqrt(Q)` and the compensation as **`sqrt(Q)`**. Calibrated against the
    table above — `2.5 * sqrt(Q)`, which is +14 dB at the default Q of 4 and
    +5 dB at the minimum of 0.5 — and **capped at ×8 (+18 dB)** so that a
    high-Q setting with material parked on the centre frequency, where the
    bandpass is already at unity, cannot run away into the master. It tracks
    `fx.wah.q` through the existing `setQ`, smoothed with `RAMP_SMOOTH` like any
    other control (REQ-2b). Exact compensation is impossible — the loss depends
    on the source spectrum, not only on Q — so this removes the step, it does not
    guarantee unity.
  - **The crossfade gets its own time constant**, `RAMP_BYPASS` = 25 ms, instead
    of borrowing `RAMP_MEDIUM`. 10 ms was the shortest constant in the audio
    layer, and REQ-2b already argues that a single effect *knob* zippers at
    anything under 20 ms; a structural dry↔wet swap was getting half of that.
    `DISCONNECT_DELAY_MS` moves 150 → 300 ms to keep ADR-012's margin: the
    disconnect must not land while wet is still audible, and twelve time
    constants puts it at −104 dB.

  The wah is correspondingly louder than it was, which is the correction, not a
  side effect: an effect that dropped the bus 16 dB when you switched it on was
  never at the right level. The demos that engage it were rebalanced in the same
  change ([song-mode](song-mode.md) — demo data rides with the fix that moved it).


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
  # bypassed 150ms -> disconnects input→processedIn, quiesce(true);
  #   then after drainSeconds() -> disconnects processedOut→wet (v8, REQ-2c)
  # un-bypass cancels both timers, reconnects and quiesce(false) before ramping.
  # DISCONNECT_DELAY_MS = 300; DRAIN_DEFAULT_S = 0.02.
WrappedEffect:  # the two hooks a stateful effect overrides (v8)
  protected drainSeconds(): number    # how long silence takes to clear its memory
  protected quiesce(on: boolean): void  # zero/restore an internal feedback path
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
  Then the wrapper has disconnected input→processedIn
   And after the effect's drainSeconds() it has disconnected processedOut→wet too
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: Two size writes in one turn land on the second (v8, REQ-10, regression)
  Given the reverb holds the small IR and a song load is applying
  When setSize is called with the default and then with the song's value, in one turn
  Then the IR that lands after the mute window is the song's, not the default
   And the reverse pair still moves it, so the guard has not simply gone away
# pinned by: tests/audio/effects/reverb.test.ts

Scenario: Re-enabling an effect never replays what was frozen in it (v8, REQ-2c)
  Given an effect was bypassed while its delay line held audio
  When it is enabled again after the drain has finished
  Then the processed path reconnects holding silence, not the old audio
   And the wet ramp starts immediately — nothing is held back for a tail length
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: A drain in progress is abandoned if the effect comes back (v8, edge)
  Given an effect was bypassed and its input is already disconnected
  When it is enabled again before drainSeconds() has elapsed
  Then both timers are cancelled, both edges are connected, and quiesce is undone
   And the feedback it was holding at zero returns to what the knob says
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

Scenario: Enabling the wah does not step the level (v10, REQ-12, regression)
  Given a held note with the wah bypassed and every other effect off
  When fx.wah.on goes to 1 and then back to 0
  Then the bus level moves by a few dB, not the 16-19 dB it moved before makeup
   And the crossfade takes RAMP_BYPASS, not RAMP_MEDIUM
# pinned by: tests/audio/effects/wah.test.ts (makeup + constant), bench:audio (the dB)

Scenario: Wah makeup tracks Q and is capped (v10, REQ-12, edge)
  Given fx.wah.q is swept from its minimum of 0.5 to its maximum of 20
  Then the makeup gain follows 2.5*sqrt(Q), smoothed with RAMP_SMOOTH
   And it stops at x8, so a narrow band on the centre frequency cannot run away
# pinned by: tests/audio/effects/wah.test.ts

Scenario: The disconnect still lands well after the crossfade (v10, REQ-2, edge)
  Given the bypass ramp is now RAMP_BYPASS
  Then DISCONNECT_DELAY_MS is at least ten of its time constants
   And the wrapper still never disconnects while wet is audible
# pinned by: tests/audio/effects/bypass.test.ts

Scenario: The wah sweep never reaches 0 Hz, at any depth (v9, REQ-11, regression)
  Given fx.wah.depth is 1 (the widest sweep the param allows)
  When the LFO is at the bottom of its cycle
  Then the bandpass centre is 622.25 / 2^(depthCents/1200) Hz, still well above 0
   And bp.frequency itself is never written after construction — the sweep is detune
# pinned by: tests/audio/effects/wah.test.ts

Scenario: Raising wah depth past 0.415 no longer steps the output (v9, REQ-11, regression)
  Given a wah at depth 0.42, where the old linear-Hz swing clamped at 0 Hz
  Then the sweep is symmetric in octaves about the centre
   And the peak single-sample step stays at the depth-0.35 level, not 10x it
# pinned by: tests/audio/effects/wah.test.ts (contract), bench:audio (the number)

Scenario: A stored song keeps the top of its wah sweep (v9, REQ-11, edge)
  Given a demo shipping fx.wah.depth 0.18
  Then the sweep still peaks at 892 Hz, as it did with the linear mapping
   And only the bottom of the sweep moves, from 352 Hz up to 434 Hz
# pinned by: tests/audio/effects/wah.test.ts

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
