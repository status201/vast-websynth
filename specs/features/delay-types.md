# Delay types (TYPE + CHAR on the existing delay, all three buses)

```yaml
id: delay-types
status: implemented
version: 5  # v5: regression: REVERSE's head gains sum to 1 while TIME or CHAR move too: a
            #     window opening hands every sounding head a fade from its current gain
            #     over the new crossfade. A TIME step used to leave the old head on its
            #     own longer fade, the sum rose toward 2 and the head steal cut one off
            #     at full gain: a click per step (43 bursts on a stepped take, 0 steady)
            # v4: regression: the synth panel's title *is* the TYPE dropdown (a DELAY ▾ legend
            #     over the type), because a separate 120 px box beside the title pushed
            #     the ON switch out of the panel at 1200 and 393 px
            # v3: regressions: a retiring core's loop is zeroed only once its output gate has
            #     closed (bypass excepted); the spring loop glides back like the main
            #     loop; the reverse worklet allocates nothing per block
            # v2: REQ-every-type-is-bounded: every loop filter is a true Butterworth (Q in dB,
            #     `BUTTERWORTH_Q_DB`); the old 0.707, read as dB, peaked +1.7 dB and DIGITAL /
            #     PING PONG ran away above FB ≈ 0.82 (regression scenario)
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
  - fx-patch-decoration # deferred in the same change, to pay for this one's boot cost
  - untrusted-input
source:
  - src/state/delay.ts                 # DELAY_TYPES: TYPE's one table (keys + labels)
  - src/state/params.ts                # delayParams: + type, char
  - src/audio/effects/delay.ts         # Delay: the digital line, and the lazy trigger
  - src/audio/effects/delay-switch.ts  # lazy: DelaySwitch — the gates, the spill, the drain, the knob bindings
  - src/audio/effects/delay-cores.ts   # lazy, with the switch: every core (digital adapter, ping-pong, analog, reverse)
  - src/audio/effects/effect.ts        # pinParam: the quiesce body, shared with the cores
  - src/audio/worklet-module.ts        # loadWorkletModule: once per context, shared with the flanger
  - public/worklets/reverse-delay.js   # the reverse core's DSP
  - public/sw.js                       # precaches the worklet
  - src/ui/components/delay-type-controls.ts # the delay's face: DELAY_KNOBS, the TYPE dropdown, CHAR's dimming
  - src/ui/panels/fx-rack.ts           # synth: the Delay panel, through FxSpec's titleControl + wire
  - src/ui/components/fx-group.ts      # delayFxGroup: the drum + sampler DELAY header group
  - src/ui/components/param-dropdown.ts # ParamDropdown's testId argument
  - src/ui/components/knob.ts          # dimWhileParamIs: CHAR dims at DIGITAL
  - src/ui/panels/drum-panel.ts
  - src/ui/panels/sampler-panel.ts
```

## Background / Why

The delay was one voicing: a `DelayNode` with a 4.5 kHz damped feedback loop — a
clean digital echo. The classic delays a player reaches for are different
*characters* of the same job: a ping-pong that throws repeats across the stereo
field, a tape echo that wobbles and darkens, a bucket-brigade that goes murky, a
Space Echo whose repeats splash through a spring tank, and a reverse echo that
swells backwards into the beat. They share TIME, FEEDBACK, MIX and the tempo
lock, and nobody chains two of them, so they are **one effect with a TYPE**, not
new effects in a slot ([fx-slot-picker](fx-slot-picker.md)). One extra **CHAR**
knob gives each type its one most musical dimension.

Compatibility is the hard constraint: every song, preset and share link that
predates TYPE must sound exactly as it did (ADR-006), and it must stay
musical, stable and cheap in that order (ADR-010). "Spring" was asked for as a
delay; a spring is a reverb tank, so it lives here as the Space Echo's tank
(the Roland RE-201 pairing) rather than as a type of its own.

## Requirements

- **REQ-the-delay-type-is-one-append-only-table** — `DELAY_TYPES` in
  `src/state/delay.ts` is the single table behind `${prefix}.type`: each entry's
  engine key and label. An index is a stored value in every song, preset and
  share link, so the list is **append-only**. What CHAR means per type is this
  table, mirrored in the in-app help:

  | Index | Label | CHAR means |
  | --- | --- | --- |
  | 0 | DIGITAL | nothing (dimmed) |
  | 1 | PING PONG | stereo width |
  | 2 | TAPE | wear: wow/flutter, saturation, darker repeats |
  | 3 | BBD | age: darker and more wobble |
  | 4 | SPACE ECHO | spring amount |
  | 5 | REVERSE | smoothness: crossfade length |

  `delayTypeOf(v)` resolves a stored value; a non-finite or out-of-range index
  resolves to DIGITAL, never throws (ADR-015).
- **REQ-digital-is-the-unchanged-delay** — `delayParams(prefix)` adds `type`
  (discrete, default 0 = DIGITAL) and `char` (0–1, default 0.5). Until a
  non-DIGITAL type is first chosen, `Delay` builds and drives **exactly** the
  graph it always did — `processedIn → delay → damp(4.5 kHz) → feedback`, same
  constants, same nodes, no gates — and CHAR writes nothing. (v2: the one
  deliberate change is the damp's `Q`, now Butterworth: REQ-every-type-is-bounded.) A song that never
  leaves DIGITAL never loads anything new.
- **REQ-the-other-types-load-on-first-use** — The first non-DIGITAL choice on a
  delay imports `delay-switch.ts` (one chunk, with the cores, for every delay). Its `DelaySwitch`
  re-routes the digital line through two unity gates in one task — the same
  samples, so the splice is inaudible — and from then on **binds the delay's
  knobs itself** (`time`/`sync`, `feedback`, `char`, `type`), while `Delay`'s own
  setters stand down so the two never both drive the line. The chunk is
  idle-warmed at boot like the flanger's (`main.ts` `warmDeferred`). A failed
  import is logged and leaves the delay DIGITAL. REVERSE also loads
  `/worklets/reverse-delay.js` once per context (`loadWorkletModule`, precached
  by `public/sw.js`); until a core is in, the wet path carries only the outgoing
  type's spill, and a failed core load is logged and leaves that wet silent.
  Either failure **retries on the next TYPE choice or the next switch-on** of
  that delay: the bus ignores a write of the value it already holds, so
  re-picking the type on show could not retry by itself. Both are operation-scoped
  ([lazy-load-failure](lazy-load-failure.md) REQ-lazy-scope-is-surfaces-not-operations);
  nothing throws into a subscriber.
- **REQ-a-type-switch-is-click-free-and-spills** — Each core sits between two
  gates. Switching TYPE ramps the old core's **input** gate to 0 (`RAMP_BYPASS`)
  and the new core's gates up from 0, so the new type starts on new audio and
  the old one's echoes **spill over** instead of being cut. After
  `DELAY_SPILL_S` (2 s) the old core's output gate ramps to 0, its feedback is
  quiesced once that gate has closed (`DISCONNECT_DELAY_MS` later, the bypass
  wrapper's own order: at a short TIME a loop stepped to 0 while still heard
  reaches the output one TIME later as a click; a bypass in that wait zeroes it
  at once, since the wrapper has already faded), and after its own
  `drainSeconds()` it is disconnected (ADR-012: an
  idle type costs nothing; a disconnected core also **sleeps**, stopping any
  source of its own, such as the analog wow and flutter sines, which a fresh
  wake re-creates). Re-selecting a still-spilling type takes it back as it is.
  A type chosen and left again before it loaded is built idle and never
  connected. A motion lane or song load that moves TYPE never clicks, which
  takes two rules (both found in review):
  - **A core lands on its knobs.** Until a core is first woken, every knob
    write lands at once (`AudioParam.value`); only from the wake on do they
    glide. Otherwise a new core's lines would glide in from 0 s and its swing
    depths from a GainNode's default of 1, which is a flam and a pitch warp on
    every first selection.
  - **A loop is never stepped back up.** The switch writes a quiesce or a
    release only when the core is not already in that state, and a release
    **glides** to the knob (`setTargetAtTime`, no cancel, so it continues from
    the pinned 0). A core taken back mid-drain still holds echoes, and stepping
    its loop gain from 0 to the knob would click. This holds for every loop a
    core has, SPACE ECHO's spring tank included.
- **REQ-each-type-has-its-own-topology** — Every core reads TIME (tempo-locked,
  clamped 0.001–2 s), FEEDBACK (0–0.95) and CHAR, and starts on the knobs as they
  stand; each is native nodes except REVERSE. The numbers are starting points
  dialled by ear, named once in `delay-cores.ts` (`ANALOG_VOICINGS`, the
  `SPRING_*` constants, and `pingPongWidth` for ping-pong's width):
  - **PING PONG** — the input is folded to mono and feeds `L`; `L → R → L` cross
    feedback through DIGITAL's damp lowpass, each line at TIME, so the first
    repeat is left and they alternate, each `fb` quieter than the last, as
    DIGITAL's are. CHAR sets width `w = 0.3 + 0.7·char`, and each side's output
    is `own·√2·cos θ + other·√2·sin θ` with `θ = (π/4)(1 − w)`
    (`pingPongGains`, REQ-ping-pong-keeps-the-digital-level).
  - **TAPE** — `delay → shaper → highpass → lowpass → feedback`, the output taken
    after the filters, with `delayTime` swung by wow (~0.55 Hz) and flutter
    (~6.5 Hz) sines whose swing is in seconds, so the pitch wobble does not
    depend on TIME. The line is built 10 ms longer than TIME's 2 s ceiling, so
    the swing is never clipped at the top. CHAR scales wow/flutter and drive,
    and lowers the lowpass.
  - **BBD** — the same loop with two cascaded lowpasses (darker, steeper), a
    slow chorus-like swing and a gentler drive. CHAR lowers the lowpass and
    deepens the swing.
  - **SPACE ECHO** — TAPE's loop at a fixed moderate wear, whose output also
    feeds a cheap spring tank: four dispersive allpass biquads into a short
    (33 ms) damped recirculating delay. CHAR is the tank's share of the wet, its
    level scaled by `1 − SPRING_FEEDBACK` to undo the loop's DC gain, the echo
    yielding a little as it comes in.
  - **REVERSE** — a worklet that plays windows of length TIME backwards on
    alternating read heads with complementary linear crossfades whose gains sum
    to 1 at every sample, while TIME and CHAR move as well: a window opening
    fades every head still sounding from its current gain to 0 over the new
    window's crossfade, as the new head fades in over the same length, so at most
    two heads ever sound; CHAR sets the crossfade from 5% to 50% of the window —
    short and punchy to long swells. TIME and CHAR are read when a window opens,
    so moving them never zippers.
- **REQ-every-type-is-bounded** — Feedback is clamped to 0.95 on every type,
  and **no filter in a feedback loop has gain above 1 at any frequency**: every
  loop lowpass and highpass (DIGITAL's and PING PONG's damp, the analog loops',
  the spring's) is a true Butterworth, `Q = BUTTERWORTH_Q_DB` (−3.01). Web Audio
  reads a lowpass/highpass `Q` in **dB**, so the 0.707 these were first written
  with was a +1.7 dB resonant bump, ×1.22 near 3.5 kHz. At FB 0.95 that is a loop
  gain of 1.16: DIGITAL and PING PONG (no saturator) grew without bound, about
  20 dB every 5 s, and BBD's cascaded bumps howled from FB ≈ 0.68. The analog
  loops also saturate with `tanh(k·x)/k` (bucketed and memoized), whose slope at
  0 is 1 and whose magnitude never exceeds 1, so the loop gain is never above
  the FEEDBACK knob's: a 0.95 feedback rings on as a long dub tail that dies away.
  The reverse worklet clamps feedback, soft-saturates its loop, reads a
  non-finite input as 0 and flushes denormals. Its `process()` allocates
  nothing: the per-channel input list is built once, in the constructor
  ([runtime-performance](runtime-performance.md) REQ-no-allocation-in-a-hot-loop).
- **REQ-ping-pong-keeps-the-digital-level** — Each ping-pong repeat carries the
  power DIGITAL's would: DIGITAL's mono echo `x` up-mixes to `L = R = x`, a power
  of `2x²`, so a repeat's own and other gains satisfy `near² + far² = 2` (an
  equal-power pan law). At width 0 both are 1, DIGITAL's image exactly; at
  width 1 the repeat is `√2·x` hard to one side. Width is never a loudness
  change in stereo (ADR-023's rule); a mono fold-down of a hard-panned repeat is
  3 dB down, the pan law's usual cost. (v1 first summed the gains to 1, which
  left ping-pong 3 to 6 dB under DIGITAL; caught in review.) The core makes
  a second channel, so on the synth bus the chain runs 2-channel after the delay
  while PING PONG's core is connected — the width on demand the chorus already
  has ([chorus](chorus.md) REQ-the-chorus-widens-without-changing-level).
- **REQ-the-delay-drains-every-live-core** — `quiesce` zeroes the live core's
  feedback (restoring the last commanded value on release, through one
  `HeldFeedback` per core) and retires any core
  still spilling at once; `drainSeconds()` is the longest of the connected cores'
  (2 s for the native lines, 2.1 s with the spring, `2 · 2 s + 0.2 s` for
  REVERSE, whose heads read up to two windows back)
  ([effects](effects.md) REQ-a-bypassed-effect-drains-before-disconnect).
- **REQ-type-is-a-header-dropdown-and-char-a-knob** — The synth Delay panel's
  title **is** the TYPE dropdown (v4): a small `DELAY ▾` legend over the type,
  unboxed and set like the other panels' titles (dropdown REQ-a-toggle-can-carry-a-legend),
  so clicking the title opens the type menu, the same gesture as a shared
  slot's title (fx-slot-picker REQ-the-title-opens-the-menu). The two lines fit
  inside the ON switch's height, so the header is no taller, and the title is
  only as wide as its type, so it never crowds the switch. Before v4 the row was
  `[Delay] [TYPE ▾]`, a compact dropdown with a 120 px floor, which pushed the
  switch out of the panel at 1200 px and covered it at 393 px. Its knobs are
  TIME · FB · CHAR · MIX (four, the Phaser's width, so the rack's layout math is
  unchanged). The drum and
  sampler `DELAY` header groups (`delayFxGroup`) carry the dropdown after the
  title (fx-group REQ-a-group-can-host-a-title-companion) and the same four
  knobs. There the dropdown **collapses with the knobs** while the delay is
  bypassed (`afterTitleCollapses`), so a bypassed DELAY group is as narrow as it
  always was. Left showing, it wrapped the sampler's bypassed header row at
  1900 px under CI's fonts ([responsive-machine-header](responsive-machine-header.md),
  `e2e/machine-header.spec.ts`). Those groups keep the inline `[DELAY] [TYPE ▾]`
  face: their strip is one line with its own title, and it never ran out of room. CHAR is **dimmed** (never hidden) while TYPE is DIGITAL
  (`dimWhileParamIs`), so its stored value stays visible for a type that uses it.
- **REQ-delay-type-gesture-inventory** — (ADR-014) TYPE adds no gesture of its
  own: it is a `ParamDropdown`, whose inventory is [dropdown](dropdown.md)'s
  (click opens, choose sets, Escape/outside closes, one menu open at a time).
  CHAR is a `Knob` with the knob inventory. Both are motion-lane and XY
  targets like any param.
- **REQ-delay-type-testids** — The dropdown carries `dropdown-<prefix>.type`
  (`ParamDropdown`'s `testId`); the knob is `knob-<prefix>.char` (minted by `Knob`).
- **REQ-the-delay-types-cost-the-boot-path-nothing-net** — Everything but the
  digital line, the two params, the label table and the header controls is in
  the lazy `delay-switch` chunk. The rest still had to come out of the entry
  chunk's headroom, which was below it, so the same change put the dormant
  patch-cable scenery behind an `import()` at its mount
  ([fx-patch-decoration](fx-patch-decoration.md) REQ-decoration-is-parity-keyed,
  v3); measured: 499.11 kB before, about 497 kB after (`npm run check:bundle`
  prints the current figure).

## Technical design

### Contract / public interface

```yaml
DELAY_TYPES: [[key, label]]              # src/state/delay.ts; index = type param
DELAY_TYPE_LABELS: string[]
DelayType: digital | pingpong | tape | bbd | spaceecho | reverse
delayTypeOf(v): DelayType                # unknown → digital
Delay:                                   # src/audio/effects/delay.ts, extends WrappedEffect
  setMix / setTime / setFeedback         # unchanged; time/feedback stand down once the switch exists
  bind(bus, prefix)                      # + .type: the first non-digital value loads the switch
DELAY_DAMP_HZ / clampDelayTime / clampDelayFeedback   # delay.ts: the line's constants, shared with every core
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
loadWorkletModule(ctx, url)              # src/audio/worklet-module.ts, shared with the flanger
pinParam(ctx, param, on, held)           # src/audio/effects/effect.ts
ParamDropdown(bus, paramId, labels, testId?)   # src/ui/components/param-dropdown.ts
DELAY_KNOBS / delayTypeDropdown(bus, prefix) / dimCharAtDigital(bus, prefix, knobs)   # delay-type-controls.ts
delayFxGroup(bus, prefix)                # src/ui/components/fx-group.ts
FxSpec.titleCompanion / FxSpec.wire      # fx-rack.ts: per-effect header control + knob wiring
dimWhileParamIs(bus, controlId, dim, paramIds, knobs)   # src/ui/components/knob.ts
```

### Data shapes

```yaml
fx.delay.type / fx.drum.delay.type / fx.sampler.delay.type: discrete 0..5, default 0
fx.delay.char / fx.drum.delay.char / fx.sampler.delay.char: 0..1, default 0.5
```

### Worklet message contract

`reverse-delay` has no port messages. AudioParams (k-rate): `time` 0.02–2 s,
`feedback` 0–0.95, `char` 0–1. Channel-transparent up to two channels, the
heads shared between them; the buffer holds two of the longest windows.

### Persistence

Only the two params, through the existing song / preset / share codecs. A
preset or song that omits them gets the defaults, DIGITAL and 0.5 (ADR-006).

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
  # Found in the pre-release sweep, confirmed by render: each window's old head
  # kept fading over its own crossfade, so a shorter TIME brought the new head in
  # before the old one left (the sum rose toward 2, +3.5 dB on the take), windows
  # opened faster than heads freed and the steal cut one off at full gain.
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

Scenario: The synth panel's title is the TYPE picker (regression, v4, REQ-type-is-a-header-dropdown-and-char-a-knob)
  Given the synth rack is built
  Then the Delay panel has no separate title: dropdown-fx.delay.type carries a DELAY legend and the current type
   And the drum and sampler DELAY groups' dropdowns carry no legend
# pinned by: tests/ui/delay-type-ui.test.ts

Scenario: The Delay header fits its panel at narrow widths (regression, v4, REQ-type-is-a-header-dropdown-and-char-a-knob)
  Given the viewport is 393 px or 1200 px wide, and TYPE is SPACE ECHO (the longest label)
  Then the Delay panel's ON switch lies inside the panel and does not overlap the TYPE title
# pinned by: e2e/delay-type-header.spec.ts

Scenario: The entry chunk stays under its ceiling (REQ-the-delay-types-cost-the-boot-path-nothing-net)
  When the app is built
  Then delay-switch is its own chunk and the entry chunk is under 500 kB
# pinned by: npm run build && npm run check:bundle (CI build job)

Scenario: Each type is musical and switches without a click (ADR-010)
  Given a short synth phrase with other lanes muted
  When it is rendered at every TYPE against a bypassed baseline, and TYPE is switched mid-phrase
  Then each type sounds like its namesake, FB 0.95 stays bounded, and no switch clicks
# pinned by: bench:audio + by ear (Blink + Gecko), heard and approved
```

## Tests & verification

- `tests/audio/effects/delay-types.test.ts` — table, defaults, splice, core
  switching, spill/drain, load failures, ping-pong gains, shaper bound.
- `tests/audio/reverse-delay-worklet.test.ts` — the worklet under Node.
- `tests/ui/delay-type-ui.test.ts` — dropdown, CHAR knob, dimming, on the three buses;
  the synth title's legend (v4).
- `e2e/delay-type-header.spec.ts` — the synth Delay header fits at 393 and 1200 px (v4).
- `tests/audio/effects/bypass.test.ts`, `tests/audio/fx-tempo-lock.test.ts` — the
  digital delay's existing contract, unchanged and green.
- `npm run typecheck && npm test && npm run spec:lint`; `npm run build && npm run check:bundle`.
- **By ear (ADR-010), signed off**: each TYPE was rendered with
  `npm run bench:audio` in Chromium and Firefox (no bursts; PING PONG at
  DIGITAL's RMS) and the takes were listened to and approved. The voicing
  numbers in `delay-cores.ts` stand as shipped; a later retune is heard the same
  way: `bench:audio` at each TYPE in both engines, FB 0.95 on TAPE/BBD, rapid
  TYPE switching, and a demo A/B against `main` for the DIGITAL no-op.
- **By ear (ADR-010), v2 Butterworth loop filters, signed off 2026-10-29**:
  DIGITAL and PING PONG at FB 0.95 and BBD at FB 0.8 were rendered before and
  after in Chromium, after in Firefox, plus a demo pass (`bench/q-*`). Before,
  the held-note takes grew (DIGITAL −24 to −6 dBFS, PING PONG to 0 dBFS
  clipping, BBD to −11 dBFS); after, they hold and decay. Listened to and
  approved: the types sound as good or better, PING PONG clearly fixed.

## Open questions / future

- A per-type FEEDBACK ceiling (letting TAPE self-oscillate past 1 into its
  saturator) would be the authentic Space Echo "runaway" — deferred until heard.
- A dedicated spring-reverb character belongs to the reverb, not here.
