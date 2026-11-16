# Oscillators & mixer (sound sources)

```yaml
id: oscillators
status: implemented
version: 8
owner: core
related:
  - architecture
  - voicing
  - ladder-filter
  - lfo                        # the `pulse` destination drives pulseWidth
  - runtime-performance        # the PWM control loop's cost contract
  - knob-soft-ceiling          # how the PWM rate cap is drawn on the RATE knob
  - oscillator-sync            # osc2 synced to osc1 by a per-voice worklet pair
  - cross-modulation           # ring mod + linear FM read Osc.signal
source:
  - src/audio/oscillator.ts    # duty bank + setPulseWidth
  - src/audio/pwm.ts
  - src/audio/waves.ts         # WAVE_TYPES, the one wave table oscillators, LFOs and PWM index
  - src/audio/voice.ts
  - src/state/params.ts
  - src/audio/engine-params.ts # bindVoiceParams (osc1/osc2/sub/noise)
  - src/ui/panels/synth-panels.ts
```

The synth's tone sources: two main oscillators, a sub-oscillator, and a noise
mixer — the raw signal before the [filter](ladder-filter.md) and FX.

## Background / Why

A classic subtractive front end: two detunable oscillators for body and beating, a
sub an octave or two down, and noise for breath. Each is a bundle of scalar params,
so it snapshots into presets and songs for free.

## Requirements

- **REQ-two-oscillators-with-full-controls** — Two main oscillators, each with
  waveform / octave / fine detune / level.
- **REQ-a-sub-oscillator-sits-below** — A sub-oscillator with waveform / octave
  (`-2..-1` only) / level, defaulting to **level 0** (a no-op).
- **REQ-noise-level-defaults-to-zero** — A noise level in the mixer, default 0.
- **REQ-osc-changes-reach-every-voice** — Every change applies to **every voice in
  the pool** live (8, or 5 on the `weak` tier, [performance-mode](performance-mode.md)),
  via the `all(...)` fan-out.
- **REQ-oscillators-have-a-pulse-width** — (v2) `osc1`/`osc2` have a **pulse width**,
  `0.5..0.95`, default `0.5`. Duty `0.5` *is* a square, so the default is an exact
  no-op (ADR-006). It applies only while the waveform is `square`; the sub is
  excluded.
- **REQ-width-swaps-a-precomputed-wave** — (v2) Width swaps a precomputed
  `PeriodicWave` on the **live** `OscillatorNode`. The bank holds `PWM_BANK_SIZE`
  waves from the pulse Fourier series (`a[n] = (2/(nπ))·sin(nπd)`), so every width
  is exactly band-limited, unlike a PolyBLEP. `setPeriodicWave` preserves phase,
  so a sweep never clicks. The bank is shared by all voices, per `AudioContext`.
- **REQ-a-wave-bank-entry-is-built-on-first-use** — (v5) Entry `i` is built the
  first time that width is used and memoized. `PWM_BANK_SIZE` is the bank's
  *resolution*, not a count paid for. A `PeriodicWave` expands into native wave
  tables, ~670 KB per entry at 48 kHz on Blink, so the whole bank is ~86 MB. That
  memory is invisible to JS tools, and building it as one synchronous burst stalls
  a gesture. Reducing `PWM_HARMONICS` is **not** a fix (table size follows the
  sample rate, not the partial count). Shrinking `PWM_BANK_SIZE` is a sound change
  (see the crossover below). A patch that sweeps the whole range converges on the
  whole bank, paid gradually ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request/REQ-immutable-artefacts-are-shared).
- **REQ-wave-writes-reach-only-a-heard-oscillator** — A wave or width change
  reaches a native node only while that node can be heard. That means two things:
  its voice is awake, from `noteOn` until idle ([voicing](voicing.md)
  REQ-an-idle-voice-is-unplugged); and the native node is the sound, not faded out
  under the sync pair. Otherwise `Osc` stores the change, still mirrors it to the
  pair, and applies it when the node is heard again. Each write is deduplicated, so
  only what actually moved touches the node. `Voice.wake()` runs before the attack,
  so a note always starts at the current wave and width. The reason is Gecko: there
  a swap is not a pointer change. Every `setPeriodicWave`, and every `type` write,
  ships the coefficients to the **audio thread**. Gecko builds the wave's
  band-limited tables there, lazily, one per pitch range the oscillator passes
  through. It also renders every started node it holds, so an idle voice paid the
  same as a sounding one. Under FM a swap costs several render quanta
  ([cross-modulation](cross-modulation.md)
  REQ-an-fm-carrier-with-a-pulse-width-runs-in-the-pair).
- **REQ-pulse-destination-sweeps-unipolar** — (v2) The LFO's `pulse` destination
  sweeps **upward** from the knob: `width = base + depth·(lfo+1)/2·(0.95−base)`.
  Duty `d` and `1−d` have identical magnitude spectra, so a bipolar sweep around
  0.5 would sound like double the LFO rate. That is the deliberate asymmetry
  against the other, bipolar destinations.
- **REQ-set-periodic-wave-is-immediate** — (v2) `setPeriodicWave` is immediate, not
  schedulable, so PWM runs from its own timer at `PWM_CONTROL_HZ`. It runs **only
  while some LFO's destination is `pulse`**. It must not ride rAF:
  `PERF_PROFILES.weak` caps fps at 15. There is one driver and two LFOs
  ([lfo](lfo.md) REQ-pulse-is-arbitrated). So each setter takes a **source index**,
  and the driver tracks an **owner**: lowest index wins, a non-owner's setters are
  ignored, and leaving `pulse` releases it. Without the claim, the other LFO
  changing destination would stop a sweep it does not own. This is a parameter
  write, not a summed connection, which is why `pulse` needs it while every other
  destination simply sums ([lfo](lfo.md)
  REQ-duplicated-destinations-sum-and-stay-bounded).
- **REQ-pwm-rate-is-clamped** — (v2) On the PWM path the LFO rate is clamped to
  `PWM_RATE_MAX`, since a faster LFO steps audibly. `lfo.rate`'s registered range is
  **unchanged**, so saved patches validate. While `pulse` is selected the cap is
  disclosed by **two cues driven from one `${prefix}.dest` listener per LFO
  page**: a hint (`pulse-hint-lfo` / `pulse-hint-lfo2`) and a
  [soft ceiling](knob-soft-ceiling.md) on the RATE knob. The cap is paint only; a
  drag still stores 20 Hz.
- **REQ-a-background-tab-throttles-pwm** — (v2) A background tab throttles timers
  to ~1 Hz while audio plays ([audio-lifecycle](audio-lifecycle.md)). The duty
  freezes at its last value (no click, no drift) and resumes on return. Accepted.

## Technical design

### Data shapes (registry)

```yaml
osc1.wave:       { discrete, labels: WAVE_LABELS, range: 0..3, default: 2 }
osc1.octave:     { range: -2..2, default: 0, unit: oct }
osc1.detune:     { range: -50..50, default: 0, unit: cents }
osc1.level:      { range: 0..1, default: 0.7 }
osc1.pulseWidth: { range: 0.5..0.95, default: 0.5 }   # no-op default (= square)
osc2.*:          # same shape; osc2.detune default 7 (slight beating out of the box)
sub.wave:        { discrete, labels: WAVE_LABELS, range: 0..3, default: 0 }
sub.octave:      { range: -2..-1, default: -1, unit: oct }
sub.level:       { range: 0..1, default: 0 }      # no-op default
mixer.noise:     { range: 0..1, default: 0 }      # no-op default
```

### Contract / public interface

```yaml
Osc:
  setWave(idx)          # re-applies the current width when entering/leaving square
  setPulseWidth(0.5..0.95)
  # width is ignored unless the wave is square; 0.5 restores osc.type='square'
  # the native node runs through a unity `fade` gain (oscillator-sync crossfades it)
  setAwake(on)          # the voice's wake/sleep; asleep = wave + width stored, not applied
  fadeNative(on)        # off = the pair is the sound; wave + width stored, not applied
waves.ts:
  SQUARE_WAVE           # the one `*.wave` index pulse width applies to
pwm.ts:
  PWM_BANK_SIZE   # duty-bank resolution
  PWM_CONTROL_HZ  # control-loop rate
  PWM_RATE_MAX    # LFO rate ceiling on this path
  PwmDriver.setBase(i, width) / dispose
  PwmDriver.setDest(src, d) / setAmount(src, a) / setRate(src, hz) / setWave(src, i)
    # src = the LFO index; setBase is osc-owned and takes no src
  PwmDriver(voices, now, onOwner?)  # onOwner: told when the owner changes hands
  PwmDriver.pwmOwner                # the LFO index sweeping the width, or null
```

Smoothness is `PWM_CONTROL_HZ ÷ rate` updates per cycle. Below about
`PWM_CONTROL_HZ ÷ (2·PWM_BANK_SIZE)` Hz (0.94 Hz today), the **bank**, not the
timer, is the limit. So halving the bank would make slow sweeps step audibly. That
is why the memory is bought back by *when* entries are built, not *how many* exist.

### Layer touchpoints

```yaml
registry: src/state/params.ts -> registerDefaults()
engine:   src/audio/engine-params.ts -> bindVoiceParams() (from Engine.subscribeParams)
  osc1.*  -> all((v, x) => v.osc1.setWave/ setOctave/ setDetuneCents/ setLevel)
  osc2.*  -> all((v, x) => v.osc2.<same>)
  sub.*   -> all((v, x) => v.setSubWave/ setSubOctave/ setSubLevel)
  noise   -> all((v, x) => v.setNoiseLevel(x))
  osc{1,2}.pulseWidth -> pwm.setBase(i, x)
  LFO.bind(bus, prefix, pwm, src) feeds the driver's other setters
graph:
  PwmDriver --(timer @ PWM_CONTROL_HZ, only while its OWNER is on pulse)--> every
    voice's osc1/osc2 .setPulseWidth(...)  # a param write, never an audio connection
ui:       src/ui/panels/synth-panels.ts (OSC1 / OSC2 / SUB panels: Knob + Segmented for wave)
  osc{N}.pulseWidth knob is shown only while osc{N}.wave === square
  LFO panel: pulseRateDisclosure(bus, prefix, rate) — one dest listener drives both cues
```

Each `Voice` owns its own `Osc` instances. Detune is in **cents**, octave in whole
octaves. PWM mirrors the LFO shape in JS. It never reads the owning LFO's audio
oscillator, and one LFO holds one destination, so the two cannot drift audibly.

## Scenarios (BDD)

```gherkin
Scenario: Detuning osc2 thickens the sound
  Given the engine is running
  When the user sets osc2.detune to 12
  Then every voice's osc2 is 12 cents sharp and beats against osc1
# pinned by: tests/state/params.test.ts, e2e/controls.spec.ts

Scenario: Sub level defaults to silent (backward compat, edge)
  Given a preset that never set sub.level
  Then sub.level is 0 and the sub-oscillator is inaudible
# pinned by: tests/state/params.test.ts (default), tests/state/preset.test.ts

Scenario: The default width is exactly a square wave (backward compat)
  Given a preset that never set osc1.pulseWidth
  Then the width is 0.5 and the oscillator uses the native square type
  And no PeriodicWave is applied
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: Width only bites on the square waveform
  Given osc1.wave is saw and osc1.pulseWidth is 0.9
  Then the oscillator stays a native sawtooth
  When the user switches osc1.wave to square
  Then the 0.9 width is applied without a further knob move
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: Sweeping width never restarts the oscillator
  Given osc1.wave is square
  When the width moves across several bank entries
  Then setPeriodicWave is called on the same live node and phase is preserved
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: One width builds one wave, not a bank (REQ-a-wave-bank-entry-is-built-on-first-use)
  Given osc1.wave is square and no width has been used yet
  When the width is set to a single value off 0.5
  Then exactly one PeriodicWave is created
  And holding that width creates no further waves
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: A revisited width reuses its entry (REQ-a-wave-bank-entry-is-built-on-first-use)
  Given the width has moved across a handful of bank entries
  When it returns to one it already used
  Then no new PeriodicWave is created for it
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: A width never selected costs nothing (REQ-a-wave-bank-entry-is-built-on-first-use)
  Given a patch that only ever uses the lower half of the duty range
  Then no PeriodicWave exists for any entry in the upper half
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: An idle voice takes no width swaps (regression, REQ-wave-writes-reach-only-a-heard-oscillator)
  Given osc2.wave is square and the voice is asleep
  When the width moves across several bank entries
  Then setPeriodicWave is not called
  When the voice wakes
  Then the current width is applied once, and waking again without a move applies nothing
# pinned by: tests/audio/oscillator-pwm.test.ts, tests/audio/voice-sync.test.ts

Scenario: An idle voice takes no wave writes either (REQ-wave-writes-reach-only-a-heard-oscillator)
  Given the voice is asleep on a saw
  When osc2.wave changes to triangle
  Then the native node's type is not written
  When the voice wakes
  Then the type is written once, and a wave set back to the one showing writes nothing
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: A native node under the pair takes no width swaps (regression, REQ-wave-writes-reach-only-a-heard-oscillator)
  Given osc2.wave is square and its native node is faded out under the sync pair
  When the width moves
  Then the pair's width param follows but setPeriodicWave is not called
  When the native node fades back in
  Then the current width is applied
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: The control loop runs only for the pulse destination
  Given lfo.dest is "cutoff"
  Then no PWM timer is scheduled
  When lfo.dest becomes "pulse"
  Then the timer starts, and stops again when the destination changes away
# pinned by: tests/audio/pwm.test.ts

Scenario: The other LFO cannot stop a sweep it does not own (regression, REQ-set-periodic-wave-is-immediate)
  Given LFO 1 owns the driver and is sweeping the width
  When LFO 2 moves its destination from "off" to "cutoff"
  Then the timer keeps running and the width keeps sweeping
# pinned by: tests/audio/pwm.test.ts

Scenario: The lowest LFO index wins the driver (REQ-set-periodic-wave-is-immediate, edge)
  Given LFO 2 claims pulse first and LFO 1 then claims it too
  Then LFO 1 owns the driver, and LFO 2's rate and amount are ignored
  And releasing the owner stops the timer and restores the base widths
# pinned by: tests/audio/pwm.test.ts

Scenario: PWM modulation is unipolar and upward from the base (REQ-pulse-destination-sweeps-unipolar)
  Given osc1.pulseWidth is 0.5 and the LFO is at full depth
  Then the swept width stays within 0.5..0.95 and never dips below the base
# pinned by: tests/audio/pwm.test.ts

Scenario: The LFO rate is capped on the PWM path (REQ-pwm-rate-is-clamped, edge)
  Given lfo.rate is 20 and lfo.dest is "pulse"
  Then the PWM sweep runs at PWM_RATE_MAX, not 20 Hz
  And lfo.rate's registered range still accepts 20
# pinned by: tests/audio/pwm.test.ts, tests/state/preset-validate.test.ts

Scenario: A backgrounded tab freezes the sweep instead of jumping it (REQ-a-background-tab-throttles-pwm, edge)
  Given the PWM loop is running and the tab is backgrounded for a minute
  When the timer fires again
  Then the duty moves at most one capped tick, rather than to an arbitrary phase
# pinned by: tests/audio/pwm.test.ts

Scenario: The width knob is only on show for the square waveform
  Given osc1.wave is saw
  Then knob-osc1.pulseWidth is hidden
  When the user selects the square waveform
  Then it appears
# pinned by: e2e/controls.spec.ts

Scenario: The rate cap is disclosed rather than silent (REQ-pwm-rate-is-clamped)
  Given lfo.dest is "pulse"
  Then the LFO panel shows the rate-cap hint
  When the destination changes to anything else
  Then the hint is hidden
# pinned by: e2e/controls.spec.ts

Scenario: The rate cap is shown on the knob, not only in prose (REQ-pwm-rate-is-clamped)
  Given lfo.dest is "pulse"
  Then knob-lfo.rate carries a PWM_RATE_MAX soft ceiling, so its arc stops there
  And lfo.rate can still be dragged to 20
  When the destination changes to anything else
  Then the ceiling is gone along with the hint, and the arc tracks the full range
# pinned by: e2e/controls.spec.ts
```

## Tests & verification

- `tests/state/params.test.ts`, `tests/audio/oscillator-pwm.test.ts`,
  `tests/audio/pwm.test.ts`, `e2e/controls.spec.ts` — `npm test` / `npm run e2e`.
- **By ear** (ADR-010, `recipes/verify-audio-by-ear.md`): `PWM_CONTROL_HZ`,
  `PWM_BANK_SIZE` and `PWM_RATE_MAX` are settled by listening for duty stepping,
  on a demo with the drums muted (an isolated held note renders unrepresentatively).
- **What a swap costs per engine** (REQ-wave-writes-reach-only-a-heard-oscillator).
  Firefox has no `OfflineAudioContext.suspend`, so a swap is modelled as a chain of
  nodes per voice, each starting on a fresh duty wave every 1/240 s. The control is
  the same chain on native sine, which Gecko computes without tables. The probe
  ran 8 voices, a saw modulator, and best of 2 runs, in ms per swap:

  | engine | no FM | FM β 0.39 | β 2 | β 6 |
  | --- | --- | --- | --- | --- |
  | Blink, 55–440 Hz | ~0 | ~0 | ~0 | ~0 |
  | Gecko, 55 Hz | 0.43 | 0.86 | 5.9 | 18.5 |
  | Gecko, 110 Hz | 0.42 | 1.2 | 8.2 | 16.0 |
  | Gecko, 440 Hz | 0.47 | 2.2 | 11.4 | — |

  A render quantum is 2.67 ms at 48 kHz.

## Open questions / future

- `WAVE_LABELS` is shared with `lfo.wave`, so a 5th *oscillator* wave means
  splitting it. A 5-option segmented row does not fit a narrow column (hence
  `param-dropdown.ts`).
- An audio-rate width `AudioParam` would need a worklet oscillator replacing the
  native ones for every voice. The one worklet oscillator there is, the sync pair
  ([ADR-026](../decisions/adr-026-oscillator-sync-is-a-per-voice-worklet-pair.md)),
  runs only while sync is engaged or freed for an FM'd pulse
  ([cross-modulation](cross-modulation.md)
  REQ-an-fm-carrier-with-a-pulse-width-runs-in-the-pair), and takes a-rate width as
  a side effect. Native PWM is unchanged.
