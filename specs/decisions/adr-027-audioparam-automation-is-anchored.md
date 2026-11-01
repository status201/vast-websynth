# ADR-027 — AudioParam automation is anchored: a continuous control retargets, and a cancel pins

```yaml
id: adr-027-audioparam-automation-is-anchored
status: accepted
date: 2026-11-01
deciders: core
related:
  - ../architecture                  # Global conventions — the anchored-cancel rule
  - ../features/performance          # REQ-the-dj-sweep-rides-detune — the defect that taught it
  - ../features/sidechain-ducking    # the first cancel that had to pin
  - ../features/effects              # pinParam / quiesceParam, the sweeps in cents
  - ../recipes/verify-audio-by-ear   # why a change touching automation gets a Gecko take
```

## Context / Forces

`cancelScheduledValues(t)` removes the in-flight ramp **and** leaves no event at
`t`, so the next ramp starts from "the value of the AudioParam". Blink reads that as
the automation's computed value. Gecko reads it as the last value explicitly
assigned (the intrinsic `.value`, which automation never writes back), so the
param snaps back and the output steps. Reading a live `.value` to seed a ramp is
the same trap in its other form. `cancelAndHoldAtTime`, which would pin natively,
is not implemented in Firefox.

The suite cannot see this. The mock `AudioParam` has a static `value` and no event
list. It shipped twice. The first was the ducker, which snapped back to the
cancelled ramp's start. The second was the DJ filter: it cancelled and re-issued a
40 ms exponential ramp on every write, so on Gecko every write restarted from the
constructed 20 kHz, and the master bus crackled whenever the knob moved. Rendered
through an `OfflineAudioContext` (`ConstantSource → Gain`, a 1.0 → 0.2 descent
commanded 60×/s, sampled every 100 ms):

```
commanded            [1, 0.92, 0.84, 0.76, 0.68, 0.60, 0.52, 0.44, 0.36, 0.28]
Blink, cancel+ramp   [1, 0.86, 0.74, 0.64, 0.55, 0.47, 0.40, 0.35, 0.30, 0.26]  lags, tracks
Gecko, cancel+ramp   [1, 1,    1,    1,    1,    1,    1,    1,    1,    1   ]  never moves
both,  setTarget     [1, 0.94, 0.86, 0.78, 0.70, 0.62, 0.54, 0.46, 0.38, 0.30]  identical (±2e-5)
```

## Decision

**A continuous control never cancels. It retargets with `setTargetAtTime`
(`rampTo` / `RAMP_SMOOTH`), which continues from wherever the curve has reached
and may be re-issued at any rate. A cancel that is unavoidable is followed,
first, by `setValueAtTime(<value now>, t)` on the same param (`pinParam`). No
audio path reads a live `.value` to decide where a ramp starts.**

`setTargetAtTime` approaches its target exponentially in *linear* units. So a
frequency sweep rides `detune` in cents, with a fixed `frequency` reference.
Cents are log-frequency, so the approach stays musical. On `frequency` it would
collapse most of the sweep into the first time constant.

`tests/audio/no-unanchored-cancel.test.ts` enforces the pin as a source rule. The
**first** thing scheduled on a param after a cancel must be a `setValueAtTime`.
A `setTargetAtTime` in first position is not an anchor.

## Alternatives considered

- **`cancelAndHoldAtTime`.** Rejected: Firefox does not implement it.
- **Cancel then `linear`/`exponentialRampToValueAtTime`, seeded from `.value`.**
  Rejected: it is the defect itself on Gecko.
- **A cancel-then-ramp helper.** Rejected: it would make the wrong pattern the
  easy one. `rampTo` needs no cancel.
- **A behavioural test.** Rejected: the mock has no event list, so cancel/ramp
  semantics are unobservable there. A source rule is what can fail.

## Consequences

- **Good:** automation renders the same on both engines. A knob, a motion lane or a
  60 Hz pointer stream may write as often as it likes.
- **Good:** one rule replaces a per-site judgement. The test names the offending
  line.
- **Trade-off:** a frequency sweep has to be expressed in cents on `detune`, and its
  endpoints derived as `1200·log2(f/ref)`. That is less obvious to read than Hz.
- **Trade-off:** a change touching `AudioParam` automation owes a Gecko render
  (`npm run bench:audio -- --browser firefox`) before sign-off. The two engines
  agree on `setTargetAtTime`; they disagree on unanchored cancels.
