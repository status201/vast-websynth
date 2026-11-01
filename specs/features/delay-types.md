# Delay types (TYPE + CHAR on the existing delay, all three buses)

```yaml
id: delay-types
status: implemented
version: 7
owner: core
related:
  - effects            # the insert-effect contract (WrappedEffect, bypass, drain, chain order)
  - tempo-lock         # TIME's lock is unchanged; every type reads the resolved time
  - chorus             # the precedent: a discrete selector over one append-only table
  - flanger            # the precedent: a worklet loaded on first use
  - dropdown           # TYPE is a ParamDropdown in the panel header
  - fx-group           # the drum/sampler header groups host the dropdown after the title
  - runtime-performance
  - lazy-load-failure  # the switch and the reverse worklet are operation-scoped imports
  - fx-patch-decoration
  - untrusted-input
source:
  - src/state/delay.ts                 # DELAY_TYPES: TYPE's one table (keys + labels)
  - src/state/params.ts                # delayParams: + type, char
  - src/audio/effects/delay.ts         # Delay: the digital line, and the lazy trigger
  - src/audio/effects/delay-switch.ts  # lazy: DelaySwitch — the gates, the spill, the drain, the knob bindings
  - src/audio/effects/delay-cores.ts   # lazy, with the switch: every core
  - src/audio/effects/effect.ts        # pinParam: the quiesce body, shared with the cores
  - src/audio/worklet-module.ts        # loadWorkletModule: once per context
  - public/worklets/reverse-delay.js   # the reverse core's DSP
  - public/sw.js                       # precaches the worklet
  - src/ui/components/delay-type-controls.ts # DELAY_KNOBS, the TYPE dropdown, CHAR's dimming
  - src/ui/panels/fx-rack.ts           # synth: the Delay panel, through FxSpec's titleControl + wire
  - src/ui/components/fx-group.ts      # delayFxGroup: the drum + sampler DELAY header group
  - src/ui/components/param-dropdown.ts # typeDropdown: shared with Dirt (dirt-types.md)
  - src/ui/components/knob.ts          # dimWhileParamIs: CHAR dims at DIGITAL
  - src/ui/panels/drum-panel.ts
  - src/ui/panels/sampler-panel.ts
```

## Background / Why

The delay was one voicing, a clean digital echo. The classic delays (ping-pong,
tape, bucket-brigade, Space Echo, reverse) are *characters* of the same job. They
share TIME, FEEDBACK, MIX and the tempo lock, and nobody chains two of them, so
they are **one effect with a TYPE**, not new slot effects
([fx-slot-picker](fx-slot-picker.md)). One **CHAR** knob gives each type its most
musical dimension. Every existing file must sound unchanged (ADR-006), and the
types must be musical, stable and cheap, in that order (ADR-010). A spring is a
reverb tank, so it lives here as the Space Echo's tank rather than as a type.

## Requirements

- **REQ-the-delay-type-is-one-append-only-table** — `DELAY_TYPES`
  (`src/state/delay.ts`) is the single table behind `${prefix}.type`: engine key
  and label. It is **append-only**, because the index is stored. CHAR per type,
  mirrored in the in-app help:

  | Index | Label | CHAR means |
  | --- | --- | --- |
  | 0 | DIGITAL | nothing (dimmed) |
  | 1 | PING PONG | stereo width |
  | 2 | TAPE | wear: wow/flutter, saturation, darker repeats |
  | 3 | BBD | age: darker and more wobble |
  | 4 | SPACE ECHO | spring amount |
  | 5 | REVERSE | smoothness: crossfade length |

  `delayTypeOf(v)` resolves a non-finite or out-of-range index to DIGITAL and
  never throws (ADR-015).
- **REQ-digital-is-the-unchanged-delay** — `delayParams(prefix)` adds `type`
  (discrete, default 0 = DIGITAL) and `char` (0–1, default 0.5). Until a
  non-DIGITAL type is first chosen, `Delay` builds and drives **exactly** the
  digital graph (`processedIn → delay → damp(4.5 kHz) → feedback`, with no gates),
  and CHAR writes nothing. The one deliberate change is the damp's Butterworth `Q`
  (REQ-every-type-is-bounded). A song that never leaves DIGITAL loads nothing new.
- **REQ-the-other-types-load-on-first-use** — The first non-DIGITAL choice imports
  `delay-switch.ts` (one chunk, with the cores, shared by every delay).
  `DelaySwitch` re-routes the digital line through two unity gates in one task,
  which is inaudible. From then on it **binds the delay's knobs itself**
  (`time`/`sync`, `feedback`, `char`, `type`), and `Delay`'s own setters stand
  down. The chunk is idle-warmed at boot (`main.ts` `warmDeferred`). REVERSE also
  loads `/worklets/reverse-delay.js` once per context (`loadWorkletModule`,
  precached by `public/sw.js`). Until a core is in, the wet path carries only the
  outgoing type's spill. A failed import is logged: the delay stays DIGITAL, or
  the wet stays silent for a failed core. It **retries on the next TYPE choice or
  the next switch-on**, because the bus ignores an equal write. Both loads are
  operation-scoped ([lazy-load-failure](lazy-load-failure.md)
  REQ-lazy-scope-is-surfaces-not-operations), and nothing throws into a subscriber.
- **REQ-a-type-switch-is-click-free-and-spills** — Each core sits between two
  gates. Switching TYPE ramps the old core's **input** gate to 0 (`RAMP_BYPASS`)
  and the new core's gates up. The new type starts on new audio, and the old one's
  echoes **spill**. After `DELAY_SPILL_S` (2 s) the old core's output gate ramps
  to 0. Its feedback is quiesced `DISCONNECT_DELAY_MS` after that gate has closed,
  because a loop zeroed while heard clicks one TIME later; a bypass in that wait
  zeroes it at once. After its `drainSeconds()` it is disconnected (ADR-012) and
  **sleeps**, stopping its own sources such as the analog wow/flutter sines. A
  wake re-creates them. The **live** core **rests** through a bypass: its sources
  stop while the wrapper is quiesced and resume before the wet ramps back, and its
  knobs keep gliding. A core taken while bypassed is taken resting. Re-selecting a
  still-spilling type takes it back as it is. A type chosen and left before it
  loaded is built idle and never connected. Two rules keep a TYPE automation
  click-free:
  - **A core lands on its knobs.** Until its first wake every knob write is
    immediate (`AudioParam.value`). Only after it do writes glide, so a new core
    never glides in from 0 s or from a gain of 1.
  - **A loop is never stepped back up.** A quiesce or release is written only on a
    state change, and a release **glides** (`setTargetAtTime`, no cancel) from the
    pinned 0. That covers every loop, SPACE ECHO's spring included.
- **REQ-each-type-has-its-own-topology** — Every core reads TIME (tempo-locked,
  clamped 0.001–2 s), FEEDBACK (0–0.95) and CHAR, and starts on the knobs as they
  stand. All are native nodes except REVERSE. The voicing numbers were dialled by
  ear and are named once in `delay-cores.ts` (`ANALOG_VOICINGS`, the `SPRING_*`
  constants, `pingPongWidth`):
  - **PING PONG** — input folded to mono into `L`; `L → R → L` cross feedback
    through DIGITAL's damp, each line at TIME, so the first repeat is left. CHAR
    sets width `w = 0.3 + 0.7·char`. Each side outputs
    `own·√2·cos θ + other·√2·sin θ` with `θ = (π/4)(1 − w)` (`pingPongGains`).
  - **TAPE** — `delay → shaper → highpass → lowpass → feedback`, with `delayTime`
    swung by wow (~0.55 Hz) and flutter (~6.5 Hz) in seconds, so the wobble is
    independent of TIME. The line is 10 ms longer than TIME's ceiling. CHAR scales
    wow/flutter and drive, and lowers the lowpass.
  - **BBD** — the same loop with two cascaded lowpasses, a slow chorus-like swing
    and a gentler drive. CHAR darkens and deepens.
  - **SPACE ECHO** — TAPE's loop at fixed wear, feeding a spring tank: four
    dispersive allpasses into a short (33 ms) damped recirculating delay. CHAR is
    the tank's share of the wet, scaled by `1 − SPRING_FEEDBACK`.
  - **REVERSE** — a worklet that plays windows of length TIME backwards on
    alternating heads, with complementary linear crossfades summing to 1 at every
    sample. A new window fades every sounding head out over its own crossfade, so
    at most two heads sound. CHAR sets the crossfade from 5 % to 50 % of the
    window. TIME and CHAR are read when a window opens, so they never zipper.
- **REQ-every-type-is-bounded** — Feedback is clamped to 0.95, and **no filter in
  a feedback loop has gain above 1 at any frequency**. Every loop lowpass and
  highpass is a true Butterworth, `Q = BUTTERWORTH_Q_DB` (−3.01), because Web Audio
  reads LP/HP `Q` in **dB**. A linear 0.707 is a +1.7 dB bump, which ran the
  loops away at high feedback. The analog loops saturate with `tanh(k·x)/k`
  (bucketed, memoized; slope 1 at 0, magnitude ≤ 1), so loop gain never exceeds
  FEEDBACK. The reverse worklet clamps feedback, soft-saturates, reads non-finite
  input as 0, flushes denormals and allocates nothing in `process()`
  ([runtime-performance](runtime-performance.md) REQ-no-allocation-in-a-hot-loop).
- **REQ-ping-pong-keeps-the-digital-level** — DIGITAL's mono echo up-mixes to
  `L = R = x`, a power of `2x²`. So ping-pong's gains satisfy `near² + far² = 2`
  (equal power): width 0 is DIGITAL's image, and width 1 is `√2·x` on one side. A
  mono fold-down of a hard-panned repeat is 3 dB down, the pan law's usual cost.
  The core makes a second channel, so on the synth bus the chain runs 2-channel
  after the delay while PING PONG is connected ([effects](effects.md)
  REQ-the-synth-chain-order).
- **REQ-the-delay-drains-every-live-core** — `quiesce` zeroes the live core's
  feedback (restored on release through one `HeldFeedback` per core) and retires a
  spilling core at once. `drainSeconds()` is the longest connected core's: 2 s for
  the native lines, 2.1 s with the spring, and `2 · 2 s + 0.2 s` for REVERSE
  ([effects](effects.md) REQ-a-bypassed-effect-drains-before-disconnect).
- **REQ-type-is-a-header-dropdown-and-char-a-knob** — The synth Delay panel's title
  **is** the TYPE dropdown: a small `DELAY ▾` legend over the type
  (dropdown REQ-a-toggle-can-carry-a-legend), opened by clicking the title like a
  shared slot's (fx-slot-picker REQ-the-title-opens-the-menu). It fits inside the
  ON switch's height and is only as wide as its type. Knobs: TIME · FB · CHAR · MIX.
  The drum and sampler `DELAY` groups (`delayFxGroup`) keep an inline
  `[DELAY] [TYPE ▾]` face, with the dropdown after the title
  (fx-group REQ-a-group-can-host-a-title-companion). It **collapses with the
  knobs** while bypassed (`afterTitleCollapses`), so a bypassed group stays narrow
  ([responsive-machine-header](responsive-machine-header.md)). CHAR is **dimmed**,
  never hidden, at DIGITAL (`dimWhileParamIs`).
- **REQ-delay-type-gesture-inventory** — (ADR-014) TYPE adds no gesture: it is a
  `ParamDropdown` ([dropdown](dropdown.md)'s inventory), and CHAR is a `Knob`.
  Both are motion-lane and XY targets.
- **REQ-delay-type-testids** — `dropdown-<prefix>.type` and `knob-<prefix>.char`.
- **REQ-the-delay-types-cost-the-boot-path-nothing-net** — Everything except the
  digital line, the two params, the label table and the header controls is in the
  lazy `delay-switch` chunk. `npm run check:bundle` holds the entry ceiling.

## Technical design

### Contract / public interface

```yaml
DELAY_TYPES: [[key, label]]              # src/state/delay.ts; index = type param
DELAY_TYPE_LABELS: string[]
DelayType: digital | pingpong | tape | bbd | spaceecho | reverse
delayTypeOf(v): DelayType                # unknown → digital
Delay:                                   # src/audio/effects/delay.ts, extends WrappedEffect
  setMix / setTime / setFeedback         # time/feedback stand down once the switch exists
  bind(bus, prefix)                      # + .type: the first non-digital value loads the switch
DELAY_DAMP_HZ / clampDelayTime / clampDelayFeedback   # delay.ts: shared with every core
DelaySwitch:                             # src/audio/effects/delay-switch.ts (lazy)
  constructor(ctx, span, line, feedback, damp, heldFeedback, quiesced)
  bind(bus, prefix)                      # time/sync, feedback, char, type
  select(type) / quiesce(on) / drainSeconds()
DELAY_SPILL_S = 2                        # delay-switch.ts
DelayCore: { input, output, setTime, setFeedback, setChar, quiesce(on, glide?), drainSeconds, wake, sleep }   # delay-cores.ts
CoreBase                                 # write(): at once until the first wake, glided after (private)
pingPongGains(char): [near, far]         # equal power: near² + far² = 2
DigitalCore                              # the Delay's own line, once the switch owns it
HeldFeedback                             # a core's feedback, held across a drain (private)
createCore(ctx, type: non-digital): Promise<DelayCore>   # one CORES entry per type, compiler-checked
pingPongWidth(char) / saturationCurve(k) / ANALOG_VOICINGS
REVERSE_MIN_TIME_S = 0.02 / REVERSE_MAX_TIME_S = 2   # mirrored from the worklet
loadWorkletModule(ctx, url)              # src/audio/worklet-module.ts
pinParam(ctx, param, on, held)           # src/audio/effects/effect.ts
ParamDropdown(bus, paramId, labels, testId?)   # src/ui/components/param-dropdown.ts
DELAY_KNOBS / delayTypeDropdown(bus, prefix) / dimCharAtDigital(bus, prefix, knobs)
delayFxGroup(bus, prefix)                # src/ui/components/fx-group.ts
FxSpec.titleCompanion / FxSpec.wire      # fx-rack.ts
dimWhileParamIs(bus, controlId, dim, paramIds, knobs)   # src/ui/components/knob.ts
```

A new type is a `DELAY_TYPES` row (append-only) **and** a `CORES` entry; the
compiler demands both.

### Data shapes

```yaml
fx.delay.type / fx.drum.delay.type / fx.sampler.delay.type: discrete 0..5, default 0
fx.delay.char / fx.drum.delay.char / fx.sampler.delay.char: 0..1, default 0.5
```

### Worklet message contract

`reverse-delay` has no port messages. AudioParams (k-rate): `time` 0.02–2 s,
`feedback` 0–0.95, `char` 0–1. It is channel-transparent up to two channels, with
the heads shared between them, and its buffer holds two of the longest windows.

### Persistence

Only the two params, through the existing codecs. Omitted values load as DIGITAL
and 0.5 (ADR-006).

## Scenarios (BDD)

```gherkin
Scenario: The type table is append-only and DIGITAL first (REQ-the-delay-type-is-one-append-only-table)
  Then DELAY_TYPE_LABELS is DIGITAL, PING PONG, TAPE, BBD, SPACE ECHO, REVERSE
   And delayTypeOf(NaN), delayTypeOf(-1) and delayTypeOf(99) are digital
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A legacy song is unchanged (REQ-digital-is-the-unchanged-delay, ADR-006)
  Given the default params on all three buses
  Then every delay type is 0 and char is 0.5
   And a Delay builds one DelayNode, one lowpass and no gates, and loads no switch
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: CHAR does nothing at DIGITAL (REQ-digital-is-the-unchanged-delay)
  Given TYPE is DIGITAL
  When fx.delay.char is moved
  Then no AudioParam is written
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: The switch splices the digital line through unity gates (REQ-the-other-types-load-on-first-use)
  When TYPE first leaves DIGITAL
  Then processedIn feeds the line through a gate at 1, and the direct edge is gone
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: Selecting a type swaps cores with a spill (REQ-a-type-switch-is-click-free-and-spills)
  Given the delay is on at DIGITAL
  When TYPE is set to TAPE
  Then the digital input gate ramps to 0 while its output stays at 1
   And the tape core's gates ramp to 1
  When DELAY_SPILL_S and the digital drain have passed
  Then the digital core's output gate is at 0 and it is disconnected from the span
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: Going back to a spilling type re-takes it (edge)
  Given TYPE went DIGITAL → TAPE less than DELAY_SPILL_S ago
  When TYPE returns to DIGITAL, then to TAPE
  Then each is taken back live and nothing is rebuilt
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A new core starts on the knobs as they stand (REQ-each-type-has-its-own-topology)
  Given TIME is 0.5 s and FB 0.7
  When TYPE is set to PING PONG
  Then both lines are at 0.5 s and both cross gains at 0.7
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A type chosen and left before it loaded is never live (edge)
  When TYPE goes TAPE → BBD before the switch lands
  Then TAPE is never built and BBD is live
  When TYPE goes REVERSE → BBD before the worklet lands
  Then the reverse core is built idle and unconnected
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A failed load leaves the delay safe and retries (REQ-the-other-types-load-on-first-use)
  Given the switch module fails once
  When TYPE is set to TAPE
  Then a warning is logged and the delay stays DIGITAL; the next choice loads it
  Given the reverse worklet fails once
  When TYPE is set to REVERSE
  Then a warning is logged and no core is live; the next REVERSE loads it
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A switch-on retries a failed load of the type on show (regression, REQ-the-other-types-load-on-first-use)
  Given TYPE is TAPE and the switch failed to load
  When TAPE is picked again
  Then nothing happens, since the bus ignores an equal write
  When the delay is switched on
  Then the load is tried again and the switch is in
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A new core lands on its knobs (regression, REQ-a-type-switch-is-click-free-and-spills)
  Given TIME is 0.5 s
  When TAPE is first selected
  Then its line is at 0.5 s with no glide, and its wow depth is seconds, not 1
   And a later TIME change glides
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: An unheard core runs nothing (regression, REQ-a-type-switch-is-click-free-and-spills)
  Given TAPE was selected, then left until it disconnected
  Then its wow and flutter sines are stopped
  When TAPE is selected again
  Then two new sines are started
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A bypassed delay runs no sines (regression, REQ-a-type-switch-is-click-free-and-spills, ADR-012)
  Given TAPE is live
  When the delay is bypassed and quiesces
  Then its wow and flutter sines are stopped
  When TYPE moves to BBD while still bypassed
  Then BBD starts no sines
  When the delay is switched on again
  Then BBD's two sines start
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A core taken back mid-drain while bypassed rests (regression, REQ-a-type-switch-is-click-free-and-spills)
  Given TAPE was switched away from, then the delay bypassed (TAPE draining)
  When TAPE is selected again before its drain ends, still bypassed
  Then its wow and flutter sines are not running
  When the delay is switched on
  Then two sines run
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A core taken back mid-drain glides its loop back (regression, REQ-a-type-switch-is-click-free-and-spills)
  Given the delay is on, and TAPE was left long enough to retire but not to disconnect
  When TAPE is selected again
  Then its loop gain approaches FB from the pinned 0, with no step
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: The analog line has headroom for the swing (regression, REQ-each-type-has-its-own-topology)
  When TAPE is built
  Then its DelayNode's maximum is above TIME's 2 s ceiling
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: Ping-pong keeps the digital level (REQ-ping-pong-keeps-the-digital-level)
  Given TYPE is PING PONG at any CHAR
  Then each channel's near² + far² is 2, DIGITAL's echo power, and the first repeat leans left
   And at CHAR 1 the far gain is 0
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: The analog loop gain never exceeds the knob (REQ-every-type-is-bounded)
  Given each analog voicing at CHAR 0 and 1
  Then the shaper curve's slope at 0 is 1 and its magnitude never exceeds 1
   And the loop gain is at most 0.95
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: No loop filter boosts, so FB 0.95 decays (regression, REQ-every-type-is-bounded)
  Given every lowpass and highpass biquad built by DIGITAL and by each core
  When its magnitude response is computed from its type, frequency and Q (read in dB)
  Then the filters in series never exceed unity at any frequency
   And so each loop's gain is at most FEEDBACK
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: A retiring core's loop is zeroed after its fade (regression, REQ-a-type-switch-is-click-free-and-spills)
  Given TIME 20 ms and FEEDBACK 0.9 on DIGITAL, and TAPE is chosen
  When the spill ends and the output gate starts to close
  Then DIGITAL's loop still holds 0.9, and is zeroed DISCONNECT_DELAY_MS later
  And a bypass inside that wait zeroes it at once
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: SPACE ECHO taken back mid-drain glides its spring in (regression, REQ-a-type-switch-is-click-free-and-spills)
  Given SPACE ECHO was left for DIGITAL and its loops are zeroed
  When SPACE ECHO is chosen again
  Then the spring loop glides back to its gain, with no step
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: The reverse worklet plays windows backwards and stays bounded (REQ-each-type-has-its-own-topology, REQ-every-type-is-bounded)
  Given an impulse into reverse-delay with time 0.1 s and feedback 0
  Then it comes back within two windows, at no more than unity
  Given a rising ramp, Then the output falls within a window
  Given full-scale noise at feedback 0.95 for 20 s with NaN injected
  Then every output sample is finite and bounded
  Given the input disconnects, Then two windows later it outputs silence
# pinned by: tests/audio/reverse-delay-worklet.test.ts

Scenario: REVERSE stays level and click-free while TIME steps (regression, REQ-each-type-has-its-own-topology)
  Given a steady input into reverse-delay at CHAR 1 and feedback 0
  When TIME steps 1.5 s → 0.6 s → 0.02 s every 0.5 s
  Then the head gains sum to 1 at every sample (a constant input comes back constant)
# pinned by: tests/audio/reverse-delay-worklet.test.ts

Scenario: Bypass drains every live core (REQ-the-delay-drains-every-live-core)
  Given TYPE is REVERSE and live
  When the delay is bypassed
  Then its feedback is pinned to 0, drainSeconds() covers the reverse buffer, and release restores it
  Given a core is spilling, When the delay is bypassed, Then it is retired at once
# pinned by: tests/audio/effects/delay-types.test.ts

Scenario: The dropdown and CHAR appear on all three buses (REQ-type-is-a-header-dropdown-and-char-a-knob, REQ-delay-type-testids)
  Given the synth rack, and the drum and sampler DELAY groups, are built
  Then each has dropdown-<prefix>.type listing the six types, and knob-<prefix>.char
   And choosing TAPE sets <prefix>.type to 2
   And CHAR is disabled while TYPE is DIGITAL and enabled at TAPE
# pinned by: tests/ui/delay-type-ui.test.ts

Scenario: The synth panel's title is the TYPE picker (REQ-type-is-a-header-dropdown-and-char-a-knob)
  Given the synth rack is built
  Then the Delay panel has no separate title: dropdown-fx.delay.type carries a DELAY legend and the current type
   And the drum and sampler DELAY groups' dropdowns carry no legend
# pinned by: tests/ui/delay-type-ui.test.ts

Scenario: The Delay header fits its panel at narrow widths (regression, REQ-type-is-a-header-dropdown-and-char-a-knob)
  Given the viewport is 393 px or 1200 px wide, and TYPE is SPACE ECHO (the longest label)
  Then the Delay panel's ON switch lies inside the panel and does not overlap the TYPE title
# pinned by: e2e/delay-type-header.spec.ts

Scenario: The entry chunk stays under its ceiling (REQ-the-delay-types-cost-the-boot-path-nothing-net)
  When the app is built
  Then delay-switch is its own chunk and the entry chunk is under its ceiling
# pinned by: npm run build && npm run check:bundle (CI build job)

Scenario: Each type is musical and switches without a click (ADR-010)
  Given a short synth phrase with other lanes muted
  When it is rendered at every TYPE against a bypassed baseline, and TYPE is switched mid-phrase
  Then each type sounds like its namesake, FB 0.95 stays bounded, and no switch clicks
# pinned by: bench:audio + by ear (Blink + Gecko), heard and approved
```

## Tests & verification

- `tests/audio/effects/delay-types.test.ts`, `tests/audio/reverse-delay-worklet.test.ts`,
  `tests/ui/delay-type-ui.test.ts`, `e2e/delay-type-header.spec.ts`; the digital
  contract stays green in `tests/audio/effects/bypass.test.ts` and
  `tests/audio/fx-tempo-lock.test.ts`. `npm run build && npm run check:bundle`.
- **By ear** (ADR-010): a retune is `bench:audio` at each TYPE in both engines, FB
  0.95 on TAPE/BBD, rapid TYPE switching, and a demo A/B against `main` for the
  DIGITAL no-op.

## Open questions / future

- A per-type FEEDBACK ceiling (TAPE self-oscillating into its saturator, the
  authentic Space Echo runaway) is deferred until heard.
- A dedicated spring-reverb character belongs to the reverb, not here.
