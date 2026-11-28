# Master limiter (MASTER LIMIT)

```yaml
id: master-limiter
status: implemented
version: 1
owner: core
related:
  - architecture
  - compressor
  - effects
  - audio-export
  - runtime-performance
  - ../decisions/adr-029-the-master-limiter-is-on-by-default
  - ../decisions/adr-010-musical-stable-cheap-dsp
  - ../decisions/adr-012-true-bypass-disconnects
source:
  - public/worklets/limiter.js        # the DSP (audio thread)
  - src/audio/limiter/node.ts         # LimiterNode wrapper
  - src/audio/effects/limiter.ts      # Limiter Effect (BypassWrapper)
  - src/audio/engine.ts               # the splice after master, the recorder tap
  - src/state/params.ts               # the fx.master.limit.* defs
  - src/ui/panels/song-panel.ts       # the LIMIT group + GrMeter
```

The last stage before the speakers and the recorder: a lookahead, stereo-linked
peak limiter that holds the output at or under a ceiling. It is on by default with
a 0 dBFS ceiling, so on its defaults it only touches audio that was going to clip.

## Background / Why

Nothing on the master bus controlled peaks. MASTER COMP is off by default, and
even on, a VCA bus compressor with a millisecond-scale attack is glue that lets
transients through by design. So every over hit a **hard clip**: at the speakers
(the float stream is clamped downstream of the browser) and in every export
(`pcm16` clamps to ±1). Overs are easy to make: the synth, drum and sampler buses
sum at unity, Dirt, resonance and makeup stages sit upstream, and some demos run
MASTER COMP as a +12 dB gain stage.

The limiter replaces that hard clip with a fast, smooth gain dip. It is a
*safety*, not a loudness maximiser. DRIVE gives the loudness use to anyone who
asks for it. It is on by default, which ADR-006 would forbid for an audible
param. [ADR-029](../decisions/adr-029-the-master-limiter-is-on-by-default.md)
records why this one is not: at its defaults it is an identity on every sample
that was in range.

## Requirements

- **REQ-the-limiter-is-the-last-stage** — The limiter sits **after the master
  volume**: `master → masterLimit → destination`, and the recorder taps the
  limiter's output. It has to come after the volume because that is where 0 dBFS
  means what the speakers and the export clip at. Before the volume, a ceiling
  would act on overs that `master.volume` (≤ 1, a song can set it as low as 0.5)
  was about to bring back into range, and the defaults would no longer be a no-op.
  The scope keeps its pre-master tap ([architecture](../architecture.md) "Audio
  graph"), so it shows the mix and not the limiting. The GR meter shows the limiting.
- **REQ-the-output-never-exceeds-the-ceiling** — For any input, at any setting,
  every output sample satisfies `|y| ≤ ceiling`, where `ceiling` is the CEILING in
  force when that sample **entered** the limiter. The gain that reaches a peak is
  computed from that peak before it is output (lookahead), so the guarantee comes
  from the gain computer, not from a clamp. A sample in the delay line was gained
  for the ceiling it met on the way in, so a CEIL turn takes effect one lookahead
  later, like everything else here. The worklet keeps each sample's ceiling beside
  it in the delay line rather than clamping it to a lower one it never saw, which
  would flat-top it. A final clamp to that stored ceiling is a backstop against
  rounding. It engages on no test input, including a ceiling swept down mid-limiting.
- **REQ-in-range-audio-passes-unchanged** — With DRIVE at 0 dB and a CEILING of
  0 dBFS, a signal that never exceeds ±1 comes out **bit-exact**, delayed by
  `LOOKAHEAD_S` (rounded to whole samples, `round(0.0015 · sampleRate)`). The gain is
  exactly 1, not approximately 1.
- **REQ-the-attack-is-a-ramp-not-a-step** — The gain falls to its target over the
  whole lookahead window (a moving average of the held gain), so a limited peak
  is a smooth dip rather than a corner. A corner is what makes a limiter sound
  like a clipper.
- **REQ-release-follows-the-program** — The release is automatic and has two
  speeds. A lone transient recovers in about `FAST_RELEASE_S`, so isolated peaks
  don't pump the mix. Sustained overload drags a slow envelope down (attack
  `SLOW_ATTACK_S`), and the gain then releases only as fast as that slow envelope
  (`SLOW_RELEASE_S`), so a dense passage isn't modulated at the rate of its
  transients. The constants are tuned by ear (ADR-010) and live in the worklet.
- **REQ-stereo-is-linked** — One gain for both channels, from `max(|L|, |R|)`. A
  peak on one side never shifts the image.
- **REQ-drive-and-ceiling-are-continuous** — DRIVE (0..+12 dB into the limiter) and
  CEILING (−6..0 dBFS) are smoothed on the main thread (`setTargetAtTime`), and the
  worklet also interpolates the drive gain across a block when it changes, so a
  knob sweep doesn't zipper.
- **REQ-a-failed-load-never-mutes-the-master** — Until its worklet is spliced in,
  the limiter's processed path is a **direct passthrough**. A wrapper that boots
  enabled therefore carries audio before `init()` attaches the node, and for the
  rest of the session if the module fails to load (logged; the master plays
  unlimited). `attachWorklet()` replaces the passthrough with the node. At boot
  this happens before the master fades in, so the swap is never heard.
- **REQ-the-limiter-posts-gain-reduction** — The worklet posts its gain reduction
  (dB ≥ 0, the deepest in the window) on its `port` at ~31 Hz. It posts nothing
  while idle, apart from one closing message that brings the meter back to 0.
  This is the same contract as [compressor](compressor.md)
  REQ-worklet-posts-gain-reduction, rendered by the same `GrMeter`. A bypass zeroes
  the meter, and posts that arrive while bypassed are dropped. The worklet keeps
  running for the bypass drain, so otherwise its last post would leave the meter
  showing a stale reading.
- **REQ-re-engaging-starts-at-rest** — A bypassed limiter is reset to rest before
  it is disconnected: both envelopes, the hold window, the attack average and the
  delay line. Otherwise the disconnect (ADR-012) freezes it mid-release, and a
  later switch-on would resume at that old reduction, so in-range audio would come
  in ducked and swell back over a second. The reset is the effect's `quiesce`,
  posted to the worklet as a `reset` message once the wet path is already silent.
- **REQ-silence-in-is-silence-out** — Silence in gives exact zeros out, and an
  envelope at rest stays at exactly 1. The envelopes snap to 1 at block end once
  within `1e-7`, so a recovery never crawls.
- **REQ-non-finite-input-never-reaches-state** — A NaN or ±Infinity input sample is
  read as 0 before it reaches the detector, the delay line or the envelopes. The
  output stays finite, and the next finite sample is processed as if the bad one
  never came.

## Technical design

### Contract / public interface

```yaml
LimiterNode:   # src/audio/limiter/node.ts
  static loadModule(ctx): Promise<void>   # via loadWorkletModule — a failure is forgotten
  static create(ctx): LimiterNode          # sync once the module is in
  input / output: AudioNode
  drive / ceiling: AudioParam              # dB, k-rate
  onGr: ((db: number) => void) | null

Limiter (Effect):   # src/audio/effects/limiter.ts — a WrappedEffect, no setMix
  attachWorklet(): void          # swap the passthrough for the node (idempotent)
  attached: boolean              # false while the passthrough is still the wet path
  bind(bus, prefix)              # .on via bindBypassMix, .drive, .ceiling
  onGr(cb)
  setBypass / setDrive / setCeiling
```

### Data shapes (the registry)

```yaml
fx.master.limit.on:      { discrete, labels: [off, on], default: 1 }   # ADR-029
fx.master.limit.drive:   { min: 0,  max: 12, default: 0, format: dB }
fx.master.limit.ceiling: { min: -6, max: 0,  default: 0, format: dB }
```

All three are song-scope like `fx.master.comp.*`. A song or preset that predates
them lacks the keys and loads the defaults: limiter on, identity in range.

### The gain computer (per sample, `public/worklets/limiter.js`)

```yaml
x:       in · driveLin          # non-finite → 0 first
p:       max(|xL|, |xR|)
target:  p > ceilLin ? ceilLin / p : 1
hold:    min(target) over the last L+1 samples      # monotonic deque, preallocated
slow:    one-pole toward hold — attack SLOW_ATTACK_S, release SLOW_RELEASE_S
fast:    min(hold, fast + (slow − fast) · kFast)     # instant attack, releases toward slow
g:       mean(fast) over the last L+1 samples        # running sum, resynced per block
y:       clamp(delayL(x) · g, ±ceilLin)
```

Why it holds: the output sample for a peak entering at `t0` leaves at `t0 + L`.
It is multiplied by the mean of `fast[t0 … t0+L]`. Each of those is ≤ the
`hold` at its own time, and each `hold` window `[k−L, k]` contains `t0`. So
`g ≤ target[t0]` and `|y| ≤ ceilLin`. At rest every term is exactly 1, the sum is
exactly `L+1`, and `g` is set to exactly 1 instead of being divided out
(REQ-in-range-audio-passes-unchanged).

### Layer touchpoints & ordering

```yaml
ctor (sync):  engine builds Limiter → passthrough wired; master → limiter → destination
init (async): loadModule starts with the other worklet loads, not after them;
              awaited (caught; failure logged) → attachWorklet()
              → the recorder taps masterLimit.output, not master
bindAll:      masterLimit.bind(bus, 'fx.master.limit') beside masterComp.bind
```

The limiter isn't a chain member (`fx-chain.ts`). It sits outside every chain, as
`masterComp` does. Bypass is the standard `BypassWrapper` crossfade plus true
disconnect (ADR-012). The dry path is undelayed and the wet path is `L` samples
late, so a toggle crossfades two copies 1.5 ms apart for `RAMP_BYPASS`. That is a
brief comb under a 25 ms ramp, heard and accepted.

### Worklet message contract

```yaml
direction: worklet -> main (node.port.onmessage)
payload:   number      # gain reduction in dB, >= 0
rate:      ~31 Hz      # every 12 blocks
when:      suppressed while idle, after one closing 0-ish message
main -> worklet: 'reset'   # quiesce(true): every state back to rest (REQ-re-engaging-starts-at-rest)
params (k-rate AudioParams): drive (dB), ceiling (dB)
processorOptions: none; L comes from sampleRate at construction
```

### Cost

The limiter is always on, so its cost is paid on every patch. It is one
2-channel instance and does about a compressor's work per sample: two `abs`, a
compare, an amortised O(1) deque step, two one-pole updates, a running-sum
update and two multiplies. There is a divide only above the ceiling, nothing
transcendental per sample, and nothing allocated in `process`.

Measured ([runtime-performance](runtime-performance.md)): `process()` alone takes
~4.5 µs per 128-frame block in V8, about 0.2% of a block at 48 kHz, and it barely
changes between silence, in-range audio and limiting. Through the real app,
`bench:perf` puts the limiter at **+0.6 points of audio-thread load idle** (6.1% →
6.8%; +0.7 on the weak tier). The pair was run in both orders, with the limiter
off then on. Under load the difference is inside the bench's ±1-point noise. Most
of the idle cost is the extra worklet node on the render path rather than the
loop, so a rest-state fast path in the DSP was not taken: it could save ~0.1 point
at most.

## Visual aids

```
preMaster ─► djLow ─► djHigh ─► masterComp ─► analyser(s) ─► master(vol) ─► masterLimit ─► destination
                                                                                  │  └──────► recorder
                                                                                  └ port (GR dB, ~31 Hz) ─► GrMeter (grmeter-fx.master.limit)
```

## Gesture inventory (ADR-014)

| Gesture | Target | Outcome |
| --- | --- | --- |
| tap | the LIMIT title switch | Engage or bypass the limiter ([fx-group](fx-group.md) REQ-fx-group-renders-switch-and-knobs). |
| drag / wheel / keys / double-tap | DRIVE, CEIL knobs | The standard `Knob` set: [knob-keyboard-access](knob-keyboard-access.md), [wheel-steps](wheel-steps.md), and double-tap resets to the default ([param-reset-baseline](param-reset-baseline.md)). |
| any | the GR meter | **Nothing.** It only indicates, like MASTER COMP's. |

The precedent is the COMP group beside it: same builder, same meter, same order
of title, knobs, meter. No new gesture is introduced.

## Scenarios (BDD)

```gherkin
Scenario: In-range audio passes bit-exact at the defaults (REQ-in-range-audio-passes-unchanged)
  Given a limiter at drive 0 dB and ceiling 0 dBFS
  When a stereo signal peaking at 0.99 runs through it
  Then the output equals the input delayed by L samples, sample for sample
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: No input gets past the ceiling (REQ-the-output-never-exceeds-the-ceiling)
  Given ceilings of 0 and -6 dBFS and drives of 0 and 12 dB
  When a full-scale square, an impulse after silence, a +40 dB burst and random noise run through it
  Then every output sample is within ±ceiling
  And the backstop clamp never changes a sample
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: A limited peak is a ramp (REQ-the-attack-is-a-ramp-not-a-step)
  Given a single over after silence
  Then the gain falls monotonically over the L samples before the peak
  And no step between two consecutive gains exceeds 1/(L+1) of the reduction
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: A transient recovers faster than a sustained overload (REQ-release-follows-the-program)
  Given one limiter fed a 2 ms burst at +12 dB and another fed a 1 s burst at +12 dB
  When both inputs return to an in-range tone
  Then the burst's gain is back within 1 dB of unity well before the sustained one's
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: A one-sided peak reduces both channels equally (REQ-stereo-is-linked)
  Given an over on the left channel only
  Then the left and right gains are identical on every sample
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: Silence in is exact silence out (REQ-silence-in-is-silence-out)
  Given a limiter that has just limited a loud passage
  When it is fed silence
  Then from the first block after the lookahead the output is exactly 0
  And within twelve seconds both envelopes are exactly 1, not crawling toward it
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: A ceiling turned down mid-limiting never flat-tops a peak (REQ-the-output-never-exceeds-the-ceiling, regression)
  Given a limiter holding a loud signal at 0 dBFS
  When the ceiling falls to -6 dBFS over a few blocks
  Then every output sample stays within the ceiling it entered under
  And the backstop clamp never changes a sample
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: A reset puts the limiter back at rest (REQ-re-engaging-starts-at-rest, regression)
  Given a limiter that has been held deep in reduction by a sustained overload
  When it is sent 'reset'
  Then the next in-range block passes bit-exact (after the lookahead) at unity gain
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: Bypassing resets the worklet and silences the meter (REQ-re-engaging-starts-at-rest, REQ-the-limiter-posts-gain-reduction)
  Given an attached limiter showing gain reduction
  When it is bypassed
  Then the meter reads 0 and a later post from the draining worklet is dropped
  And quiesce posts 'reset' to the worklet
# pinned by: tests/audio/effects/limiter.test.ts

Scenario: NaN and Infinity never poison the state (REQ-non-finite-input-never-reaches-state, failure guard)
  Given a block containing NaN, +Infinity and -Infinity samples
  Then every output sample is finite
  And an in-range block that follows passes bit-exact
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: The meter hears limiting and stays quiet at rest (REQ-the-limiter-posts-gain-reduction)
  Given a limiter fed an in-range tone for a second
  Then nothing is posted on its port
  When it is fed an overload
  Then a positive gain reduction is posted
  And after the overload ends one final near-zero message is posted, then nothing
# pinned by: tests/audio/limiter-worklet.test.ts

Scenario: An unloaded limiter is a wire, not a mute (REQ-a-failed-load-never-mutes-the-master)
  Given the limiter effect is constructed and enabled but its worklet never attaches
  Then its processed path connects processedIn straight to processedOut
  When attachWorklet() runs after the module loads
  Then the passthrough edge is gone and the node sits in its place, with drive and ceiling replayed
# pinned by: tests/audio/effects/limiter.test.ts

Scenario: The limiter is last, and the recorder hears it (REQ-the-limiter-is-the-last-stage)
  Given the engine is built and initialised
  Then master connects to the limiter, the limiter connects to destination
  And the recorder's input is fed from the limiter, not from master
# pinned by: tests/audio/engine-master-limit.test.ts (a source rule: no unit test builds a whole Engine),
#            and every bench:audio render goes through the real graph

Scenario: The LIMIT group is on the Song panel and engaged by default (REQ-the-limiter-is-the-last-stage)
  Given the app has booted with no saved session
  Then the LIMIT group shows DRIVE and CEIL knobs and a grmeter-fx.master.limit meter
  And fx.master.limit.on reads 1
  When the user switches LIMIT off
  Then fx.master.limit.on reads 0
# pinned by: e2e/compressor.spec.ts
```

## Tests & verification

- Unit: `tests/audio/limiter-worklet.test.ts` (stubs the worklet globals through
  `tests/worklet-harness.ts` and imports `public/worklets/limiter.js`; folds each
  render to peak/finite and asserts once per render);
  `tests/audio/effects/limiter.test.ts`; `tests/audio/engine-master-limit.test.ts`.
  Run with `npm test`.
- E2E: `e2e/compressor.spec.ts`, run with `npm run e2e`.
- **By ear** (ADR-010, the gate that counts): `npm run bench:audio -- --demo <name>`
  with and without `--set fx.master.limit.on=0`, on Chromium and `--browser firefox`,
  for the demos that clipped before. The peak survey that found them is in
  ADR-029. Listen for a clean demo being indistinguishable, and for DRIVE at +6/+12
  on a drum-heavy song.
- Cost: `npm run bench:perf -- --name limit-off` (with the limiter switched off) against
  `--name limit-on`.

## Open questions / future

- **True-peak (inter-sample) detection is declined for cost.** It would need 4×
  oversampling of the detector. The ceiling limits sample peaks, so a reconstructed
  waveform or an MP3 decode can overshoot 0 dBFS by a fraction of a dB. Anyone who
  cares can lower CEILING. Revisit only if a listener hears it.
- A RELEASE knob was considered and left out: the program-dependent release is
  meant to be invisible, and the Song row is already full.
