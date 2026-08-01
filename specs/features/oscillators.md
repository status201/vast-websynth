# Oscillators & mixer (sound sources)

```yaml
id: oscillators
status: implemented
version: 3                     # v3: the REQ-9 rate cap is shown on the knob, not only in prose
                               # v2: pulse-width modulation on osc1/osc2
owner: core
related:
  - architecture
  - voicing
  - ladder-filter
  - lfo                        # the `pulse` destination drives pulseWidth
  - runtime-performance        # the PWM control loop's cost contract
  - knob-soft-ceiling          # v3: how REQ-9's cap is drawn on the RATE knob
source:
  - src/audio/oscillator.ts    # duty bank + setPulseWidth
  - src/audio/pwm.ts           # the control loop (v2)
  - src/audio/voice.ts
  - src/state/params.ts
  - src/audio/engine.ts        # subscribeParams (osc1/osc2/sub/noise)
  - src/ui/app.ts
```

The synth's tone sources: two main oscillators, a sub-oscillator, and a noise
mixer — the raw signal before the [filter](ladder-filter.md) and FX.

## Background / Why

A classic subtractive-synth front end. Two detunable oscillators give body and
movement (beating when detuned); the sub adds weight an octave (or two) down; the
noise source adds breath/percussive transient material. Each is a plain bundle of
scalar params, so they snapshot into presets/songs for free.

## Requirements

- **REQ-1** — Two main oscillators, each with waveform / octave / fine detune /
  level.
- **REQ-2** — A sub-oscillator with waveform / octave (only `-2..-1`) / level,
  defaulting to **level 0** (no-op for existing presets).
- **REQ-3** — A noise level in the mixer, default 0.
- **REQ-4** — Every change applies to **all 8 voices** live (via the `all(...)`
  fan-out).
- **REQ-5** — (v2) `osc1`/`osc2` have a **pulse width**, `0.5..0.95`, default
  `0.5`. Duty `0.5` *is* a square wave, so the default is an exact no-op
  (ADR-006). It applies only while that oscillator's waveform is `square`; the
  sub-oscillator is excluded.
- **REQ-6** — (v2) Width is realised by swapping a precomputed `PeriodicWave` on
  the **live** `OscillatorNode`. The bank holds `PWM_BANK_SIZE` waves built from
  the pulse Fourier series (`a[n] = (2/(nπ))·sin(nπd)`), so every width is
  exactly band-limited — the same construction as the native waveforms, and
  alias-free where a PolyBLEP approximation would not be. `setPeriodicWave`
  preserves the oscillator's phase, so sweeping never clicks. The bank is built
  once per `AudioContext` and shared by all voices.
- **REQ-7** — (v2) The LFO's `pulse` destination sweeps width **unipolar and
  upward** from the knob's base: `width = base + depth·(lfo+1)/2·(0.95−base)`.
  Bipolar modulation around `0.5` would sweep through `0.4`/`0.3`, and duty `d`
  and `1−d` have identical magnitude spectra — so the sweep would sound like
  *double* the LFO rate. This is a deliberate asymmetry versus the other
  destinations, which are bipolar around their base.
- **REQ-8** — (v2) `setPeriodicWave` is an immediate call, not schedulable
  automation, so PWM runs from a control loop at `PWM_CONTROL_HZ`. It runs
  **only while `lfo.dest === pulse`** and is stopped otherwise, so the feature
  costs nothing in any other patch. It owns its own timer and must **not** ride
  `requestAnimationFrame` — `PERF_PROFILES.weak` caps fps at 15
  ([runtime-performance](runtime-performance.md)), which would make PWM unusable
  on that tier.
- **REQ-9** — (v2) On the PWM path the LFO rate is clamped to `PWM_RATE_MAX`,
  because smoothness is `PWM_CONTROL_HZ ÷ rate` updates per cycle and a faster
  LFO steps audibly. `lfo.rate`'s registered range is **unchanged** — narrowing
  it would make `preset-validate` reject every saved patch with a faster LFO —
  so the UI discloses the cap while `pulse` is selected rather than the knob
  silently doing nothing. (v3) The disclosure is **two cues, one subscription**:
  the panel hint *and* a [soft ceiling](knob-soft-ceiling.md) at `PWM_RATE_MAX`
  on the RATE knob, which stops its arc filling through the dead travel. Both are
  driven from the same `lfo.dest` listener so they cannot drift apart, and both
  disappear for every other destination, where the full `0.05..20` range really
  is live. The cap is paint only — dragging still reaches and stores 20 Hz.
- **REQ-10** — (v2) A background tab throttles main-thread timers to ~1 Hz while
  audio keeps playing ([audio-lifecycle](audio-lifecycle.md)). The duty then
  freezes at its last value: no click, no drift, and it resumes on return.
  Accepted rather than worked around.

## Technical design

### Data shapes (registry)

```yaml
osc1.wave:       { discrete, labels: WAVE_LABELS, range: 0..3, default: 2 }
osc1.octave:     { range: -2..2, default: 0, unit: oct }
osc1.detune:     { range: -50..50, default: 0, unit: cents }
osc1.level:      { range: 0..1, default: 0.7 }
osc1.pulseWidth: { range: 0.5..0.95, default: 0.5 }   # v2, no-op default (= square)
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
pwm.ts:
  PWM_BANK_SIZE   # duty-bank resolution
  PWM_CONTROL_HZ  # control-loop rate
  PWM_RATE_MAX    # LFO rate ceiling on this path (REQ-9)
  PwmDriver.setDest / setBase / setAmount / setRate / setWave / dispose
```

Both `PWM_CONTROL_HZ` and `PWM_RATE_MAX` are tuning constants: smoothness is
`PWM_CONTROL_HZ ÷ rate` updates per cycle, and below roughly
`PWM_CONTROL_HZ ÷ (2·PWM_BANK_SIZE)` Hz the **bank**, not the timer, is the
limit — a full LFO cycle sweeps the bank up and back.

### Layer touchpoints

```yaml
registry: src/state/params.ts -> registerDefaults()
engine:   src/audio/engine.ts -> subscribeParams()
  osc1.*  -> all((v, x) => v.osc1.setWave/ setOctave/ setDetuneCents/ setLevel)
  osc2.*  -> all((v, x) => v.osc2.<same>)
  sub.*   -> all((v, x) => v.setSubWave/ setSubOctave/ setSubLevel)
  noise   -> all((v, x) => v.setNoiseLevel(x))
  osc{1,2}.pulseWidth -> pwm.setBase(i, x)          # v2
  lfo.{dest,rate,wave,amount} + master.modWheel -> pwm.<setter>  # v2
graph (v2):
  PwmDriver --(timer @ PWM_CONTROL_HZ, only while dest=pulse)--> every voice's
    osc1/osc2 .setPulseWidth(...)      # a param write, never an audio connection
ui:       src/ui/app.ts  (OSC1 / OSC2 / SUB panels: Knob + Segmented for wave)
  osc{N}.pulseWidth knob is shown only while osc{N}.wave === square
  LFO panel: pulseRateDisclosure() — ONE lfo.dest listener drives both REQ-9 cues,
    the rate-cap hint's visibility AND knob-lfo.rate's soft ceiling (v3)
```

Each `Voice` (`src/audio/voice.ts`) owns its own `Oscillator` instances
(`src/audio/oscillator.ts`); detune is in **cents**, octave in whole octaves.

PWM is the one modulation path that is **not** an audio-node connection: there is
no width `AudioParam` on a native `OscillatorNode`, so the LFO shape is mirrored
in JS and applied as a parameter write. It therefore does not use the audio LFO's
own oscillator, and cannot drift against it in any way that matters — destinations
are exclusive, so nothing else reads the audio LFO while `pulse` is selected.

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

Scenario: The control loop runs only for the pulse destination
  Given lfo.dest is "cutoff"
  Then no PWM timer is scheduled
  When lfo.dest becomes "pulse"
  Then the timer starts, and stops again when the destination changes away
# pinned by: tests/audio/pwm.test.ts

Scenario: PWM modulation is unipolar and upward from the base (REQ-7)
  Given osc1.pulseWidth is 0.5 and the LFO is at full depth
  Then the swept width stays within 0.5..0.95 and never dips below the base
# pinned by: tests/audio/pwm.test.ts

Scenario: The LFO rate is capped on the PWM path (REQ-9, edge)
  Given lfo.rate is 20 and lfo.dest is "pulse"
  Then the PWM sweep runs at PWM_RATE_MAX, not 20 Hz
  And lfo.rate's registered range still accepts 20
# pinned by: tests/audio/pwm.test.ts, tests/state/preset-validate.test.ts

Scenario: A backgrounded tab freezes the sweep instead of jumping it (REQ-10, edge)
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

Scenario: The rate cap is disclosed rather than silent (REQ-9)
  Given lfo.dest is "pulse"
  Then the LFO panel shows the rate-cap hint
  When the destination changes to anything else
  Then the hint is hidden
# pinned by: e2e/controls.spec.ts

Scenario: The rate cap is shown on the knob, not only in prose (REQ-9, v3)
  Given lfo.dest is "pulse"
  Then knob-lfo.rate carries a PWM_RATE_MAX soft ceiling, so its arc stops there
  And lfo.rate can still be dragged to 20
  When the destination changes to anything else
  Then the ceiling is gone along with the hint, and the arc tracks the full range
# pinned by: e2e/controls.spec.ts
```

## Tests & verification

- `tests/state/params.test.ts` (registration/defaults/clamp),
  `tests/audio/oscillator-pwm.test.ts`, `tests/audio/pwm.test.ts`.
- `e2e/controls.spec.ts` (control surface). `npm test` / `npm run e2e`.
- **By ear** (ADR-010, `recipes/verify-audio-by-ear.md`): `PWM_CONTROL_HZ`,
  `PWM_BANK_SIZE` and `PWM_RATE_MAX` are only settled by listening for duty
  stepping — on a **demo song with the drums muted**, not on an isolated held
  note, which renders unrepresentatively.

## Open questions / future

- `WAVE_LABELS` order is defined in `params.ts`; a 5th waveform would extend the
  discrete range + labels and need no engine change beyond `Oscillator.setWave`.
  Note the array is shared with `lfo.wave`, so a 5th *oscillator* wave means
  splitting it — and `param-dropdown.ts` exists because a 5-option segmented row
  does not fit a narrow panel column.
- A true audio-rate `width` `AudioParam` would need a PolyBLEP worklet
  oscillator, replacing the native node for osc1/osc2 and re-homing glide,
  detune, unison, drift and pitch bend onto it. Rejected here: PolyBLEP aliases
  above ~2 kHz where the native band-limited oscillator does not, and voices run
  continuously, so it would mean 16 always-on processors. Propose it against
  ADR-010 rather than adding it silently.
