# Chorus (stereo, Juno-style, on the synth and sampler buses)

```yaml
id: chorus
status: implemented
version: 2   # v2: the flanger joins between the phaser and the chorus (flanger.md), so the
             #     chorus now follows the flanger; it still comes after all the modulation
             #     and before the delay (REQ-the-chorus-sits-after-the-phaser)
owner: core
related:
  - effects            # the insert-effect contract it implements (WrappedEffect, bypass, drain)
  - fx-slot-picker     # the UI: it shares the Phaser's panel through a title caret
  - architecture
  - sampler
source:
  - src/audio/effects/chorus.ts
  - src/audio/effects/fx-chain.ts      # synth + sampler chains, after the phaser
  - src/state/chorus.ts                # CHORUS_MODES: MODE's one table (labels + values)
  - src/state/params.ts                # chorusParams
  - src/state/preset.ts                # the base reset carries fx.chorus.on: 0
  - src/ui/panels/fx-rack.ts           # synth: shares the Phaser panel
  - src/ui/panels/sampler-panel.ts     # sampler: shares the PHASER group
```

## Background / Why

VAST had every classic insert except a chorus — the one effect a polysynth pad,
a string patch or an electric piano most expects. It is built the way the
Roland Juno built its own, because that design is the one that is musical,
stable and cheap at once ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)):
a mono signal through a short delay line whose time is swept by a slow
triangle, read out twice in **antiphase** — one tap to the left, one to the
right. The antiphase is what makes it wide: while one side's pitch drifts up the
other drifts down, so the image spreads instead of wobbling. There is no feedback
path, so there is nothing to run away.

It is the first insert that **makes** a stereo image on the synth bus rather than
carrying one (effects.md "Open questions" recorded its absence), so it is also
the first to exercise [ADR-023](../decisions/adr-023-the-synth-channel-goes-stereo-on-demand.md)'s
generalisation: width is paid for only while asked for, and a channel count
never decides a level.

## Requirements

- **REQ-the-chorus-is-two-antiphase-taps** — `Chorus` (a `WrappedEffect`)
  builds `processedIn → tone → tapL, tapR → merger(L, R) → processedOut`:
  - `tone` is a lowpass biquad (`CHORUS_TONE_HZ`, Q 0.707) pinned to **one
    channel** (`channelCount 1`, `'explicit'`). It is the BBD's darkening, and it
    down-mixes a stereo input (the sampler bus) *before* the delays, so both taps
    always run mono — half the work of a channel-transparent design.
  - `tapL` and `tapR` are `DelayNode`s whose `delayTime` sits at a fixed centre
    `CHORUS_CENTRE_S` and is swept by **one** triangle LFO through two gains, `+w`
    on the left and `−w` on the right.
  - The dry path is the wrapper's own and is untouched, so a stereo input keeps
    its image in the dry signal; only the wet is re-imaged.
- **REQ-the-chorus-delay-never-reaches-zero** — The swing is `w = depth ×
  CHORUS_SWING_S`, clamped by `chorusSwing` so the shortest delay either tap
  can reach is `CHORUS_MIN_DELAY_S` (0.5 ms). A delay line driven to 0 stops
  being a delay, and an automated `delayTime` at its floor is exactly where two
  engines' implementations start to disagree — the wah and phaser both learned
  that ([effects](effects.md) REQ-the-wah-lfo-sweeps-in-cents, REQ-the-phaser-sweeps-in-cents).
- **REQ-the-chorus-mode-overrides-rate-and-depth** — `mode` is a discrete param
  over `CHORUS_MODE_LABELS = FREE · I · II · I+II` (append-only: an index is a
  stored value). `FREE` applies the RATE and DEPTH knobs. Each other mode applies
  its own fixed pair and **ignores the knobs without touching them** — their
  stored values survive and return the moment the mode goes back to `FREE`, the
  same contract the tempo lock keeps with a rate knob ([tempo-lock](tempo-lock.md)).
  Labels and pairs are **one table**, `CHORUS_MODES` in `src/state/chorus.ts`,
  so the param's labels and the engine's values cannot drift apart; the params a
  mode overrides are `CHORUS_MODE_OVERRIDES`, which both the engine's
  resolution and the UI's dimming read. Resolved in `bind` through
  `chorusModePreset`, so the setters stay plain:

  | Mode | Rate | Depth | Character |
  | --- | --- | --- | --- |
  | I | 0.5 Hz | 0.5 | the slow, gentle Juno I |
  | II | 0.85 Hz | 0.7 | faster and deeper — Juno II |
  | I+II | 8 Hz | 0.12 | fast and shallow, the shimmer the Juno got pressing both |

  The numbers are starting points dialled by ear (ADR-010), named in one table.
- **REQ-the-chorus-has-no-tempo-lock** — RATE is free-running only. A chorus is a
  slow detuning shimmer that is not meant to land on the grid, and leaving it out
  of `TEMPO_LOCKS` keeps the param set to five.
- **REQ-the-chorus-drains-briefly** — `drainSeconds()` is `0.05`: the taps hold
  at most `CHORUS_CENTRE_S + CHORUS_SWING_S` of audio and the biquad rings for
  less. There is no feedback loop, so `quiesce` is not overridden
  ([effects](effects.md) REQ-a-bypassed-effect-drains-before-disconnect).
- **REQ-the-chorus-sits-after-the-phaser** — Synth chain: `eq → dist → wah →
  phaser → flanger → chorus → delay → reverb → duck`. Sampler chain: `eq → dist →
  phaser → flanger → chorus → delay → reverb → duck` (v2: the flanger,
  [flanger](flanger.md) REQ-the-flanger-sits-between-phaser-and-chorus). After the
  modulation it shares a panel with,
  before the delay and reverb so their tails carry its width — the pedalboard
  order. The **drum bus has no chorus**.
- **REQ-the-chorus-widens-without-changing-level** — Switching the chorus on adds
  width, never level. On the synth bus the chain is 1-channel up to the chorus;
  while it is on, everything after it (delay, reverb, duck) runs 2-channel, and
  when it is bypassed ADR-012's disconnect drops its stereo edge so the chain is
  1-channel again — width on demand, ADR-023's first half, with no new splice.
  The second half is already in place: `synthPan`'s input is pinned to two
  channels (`forceStereo`), so the mono dry up-mixes to `L = R = x` at unity and
  meets the stereo wet without a 3 dB step.
- **REQ-the-chorus-params-default-to-a-no-op** — `chorusParams(prefix)` registers
  `on` (default 0, ADR-006), `rate` 0.05–10 Hz (0.5), `depth` 0–1 (0.5),
  `mode` (0 = FREE) and `mix` 0–1 (0.5), at `fx.chorus` and
  `fx.sampler.chorus`. The preset base reset carries `fx.chorus.on: 0`, so a
  factory preset sets the whole sound ([presets](presets.md)
  REQ-a-factory-preset-sets-the-full-sound).

## Technical design

### Contract / public interface

```yaml
Chorus:          # src/audio/effects/chorus.ts — extends WrappedEffect
  constructor(ctx)
  setMix(m) / setRate(hz) / setDepth(d)        # RAMP_SMOOTH, setTargetAtTime only
  bind(bus, prefix)                            # .on/.mix via bindBypassMix; rate/depth/mode resolved here
  drainSeconds(): 0.05
chorusSwing(depth): number                     # seconds, clamped (REQ-the-chorus-delay-never-reaches-zero)
CHORUS_MODES: [{label, preset: {rate, depth} | null}]   # src/state/chorus.ts; index = mode param
CHORUS_MODE_LABELS = CHORUS_MODES' labels; CHORUS_MODE_OVERRIDES = [rate, depth]
chorusModePreset(mode): {rate, depth} | null   # null = FREE (or an unknown index): the knobs rule
CHORUS_CENTRE_S / CHORUS_SWING_S / CHORUS_MIN_DELAY_S / CHORUS_TONE_HZ
```

### Data shapes

```yaml
fx.chorus.on/rate/depth/mode/mix            # synth bus
fx.sampler.chorus.on/rate/depth/mode/mix    # sampler bus
mode: discrete 0..3, labels CHORUS_MODE_LABELS, default 0 (FREE)
```

### Layer touchpoints & ordering

`createSynthChain` / `createSamplerChain` instantiate it between `phaser` and
`delay` and bind it at its prefix (ADR-008). Engine is unchanged. The UI is the
shared slot of [fx-slot-picker](fx-slot-picker.md); the knobs named by
`CHORUS_MODE_OVERRIDES` are dimmed by `dimWhileModeSet` (`Knob.setDisabled`
underneath) while `mode` is not FREE — picked by param id, never by position.

## Scenarios (BDD)

```gherkin
Scenario: The two taps sweep in antiphase (REQ-the-chorus-is-two-antiphase-taps)
  Given a chorus at depth d in FREE mode
  Then the left tap's LFO gain is +chorusSwing(d) and the right tap's is -chorusSwing(d)
   And both taps' delayTime rests at CHORUS_CENTRE_S
# pinned by: tests/audio/effects/chorus.test.ts

Scenario: The delay never reaches zero, at any depth (REQ-the-chorus-delay-never-reaches-zero)
  Given depth is swept from 0 to 1
  Then CHORUS_CENTRE_S - chorusSwing(depth) is never below CHORUS_MIN_DELAY_S
# pinned by: tests/audio/effects/chorus.test.ts

Scenario: A mode overrides the knobs without moving them (REQ-the-chorus-mode-overrides-rate-and-depth)
  Given fx.chorus.rate is 3 and fx.chorus.depth is 0.9
  When fx.chorus.mode is set to I
  Then the LFO runs at 0.5 Hz with the I depth, and the bus still holds 3 and 0.9
  When fx.chorus.mode returns to FREE
  Then the LFO runs at 3 Hz with depth 0.9 again
# pinned by: tests/audio/effects/chorus.test.ts

Scenario: A knob turned while a mode is set does not leak through (edge)
  Given fx.chorus.mode is II
  When fx.chorus.rate is written
  Then the LFO rate stays at the II rate
# pinned by: tests/audio/effects/chorus.test.ts

Scenario: The chorus sits after the phaser on both buses (REQ-the-chorus-sits-after-the-phaser)
  Then the synth and sampler chains wire phaser -> flanger -> chorus -> delay
   And the drum chain has no chorus
# pinned by: tests/audio/effects/chorus.test.ts

Scenario: Synth and sampler choruses are independent (edge)
  Given fx.chorus.on is 1 and fx.sampler.chorus.on is 0
  Then only the synth chain's chorus is engaged
# pinned by: tests/audio/effects/effect-bind.test.ts

Scenario: A legacy song is unchanged (REQ-the-chorus-params-default-to-a-no-op, ADR-006)
  Given a song saved before fx.chorus.* existed
  When it is loaded
  Then fx.chorus.on and fx.sampler.chorus.on are 0 and the chorus is bypassed
# pinned by: tests/state/params.test.ts

Scenario: Enabling the chorus does not step the level (REQ-the-chorus-widens-without-changing-level)
  Given a held chord, the reverb off, the transport stopped
  When fx.chorus.on goes to 1 at mix 0.5
  Then the short-window RMS either side of the toggle differs by a few dB at most
# pinned by: bench:audio (by ear and by RMS, Blink + Gecko — ADR-010)
```

## Tests & verification

- `tests/audio/effects/chorus.test.ts` — graph, swing clamp, mode resolution,
  chain order, drain.
- `tests/audio/effects/effect-bind.test.ts` — per-prefix independence.
- `tests/state/params.test.ts` — registered, defaults off.
- `tests/ui/help-content.test.ts` — the in-app copy names the chorus in chain
  order and documents every MODE label.
- `npm run bench:audio` in Chromium **and** `--browser firefox`: an A/B against a
  bypassed baseline, each mode, depth 1 at the top rate. Sound is signed off by
  a listener, not by the suite (ADR-010). **Signed off by ear 2026-10-28** by
  the owner, at the shipped constants and MODE table.

## Open questions / future

- A **WIDTH** knob (scaling the antiphase toward mono) would let a mono-critical
  mix narrow it. Not built: MIX already trades width for dry, and a sixth param
  should come from a listener asking for it.
- The drum bus has no chorus, by choice — revisit if a song wants chorused hats.
