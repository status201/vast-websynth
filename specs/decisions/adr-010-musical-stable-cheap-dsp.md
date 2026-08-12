# ADR-010 — DSP worklets favour musical, stable, cheap over physical accuracy

```yaml
id: adr-010-musical-stable-cheap-dsp
status: accepted
date: 2026-06-25
deciders: core
related:
  - ../features/ladder-filter
  - ../features/compressor
  - ../recipes/add-an-audioworklet
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

We run custom DSP on the audio thread — the **ladder filter** and the **FET/VCA
compressors** ([ADR-002](adr-002-audioworklet-compressor.md)) — inside a browser
tab, across **8-voice polyphony × 2 channels**, often with several worklet
instances live at once. Two forces pull against physical accuracy. First, budget:
a tab cannot spend a native plug-in's CPU, so per-sample cost is multiplied by
every voice and instance. Second, payoff: musicians perceive *"fat / alive /
musical"* far more strongly than circuit fidelity — accuracy that nobody hears is
wasted. And whatever we ship must never put a NaN, a denormal stall, or runaway
feedback into someone's speakers.

## Decision

Every audio-thread DSP worklet is tuned to three priorities — and when they
conflict, **in this order**:

1. **Musical** — optimise for *perceived* behaviour (psychoacoustic), not
   circuit/measurement accuracy.
2. **Stable** — output is bounded and finite for *any* input at *any* setting; no
   NaN / denormal blow-ups. Non-negotiable.
3. **Cheap** — minimal per-sample work, so it scales across polyphony and multiple
   instances; prefer a rational approximation to a transcendental.

How each worklet embodies it:

- **`ladder-filter`** (`public/worklets/ladder-filter.js`) — per-stage rational
  saturation `x / (1 + |x|)` rather than `tanh` (*cheap* + smooth, *musical*
  overdrive); the feedback is read from **saturated** state so the loop is bounded
  and cannot run away (*stable*); resonance make-up gain + a `power`-taper
  resonance knob serve perception, not accuracy (*musical*). `sat'(0) === 1`, so
  low-level tone matches the linear ladder — existing presets are preserved.
- **`hardware-compressor`** (`public/worklets/compressor.js`) — a *recognisable*
  1176-FET and SSL-VCA **character** (feedback detector, program-dependent /
  auto release, soft knee, "all buttons in") chosen for feel over the native
  node's accuracy (*musical*, the substance of [ADR-002](adr-002-audioworklet-compressor.md));
  bounded and **unit-tested for boundedness** (*stable*); runs cheaply on the
  audio thread (*cheap*).
- The **`recorder`** worklet is a pure zero-output sink — no DSP character — so it
  is out of scope here.

## Alternatives considered

- **Full ZDF / TPT (zero-delay-feedback) filters** — rejected: more accurate
  tuning and self-oscillation, but per-sample Newton iteration is too costly
  across 8 voices for a marginal perceived gain.
- **Transistor-thermal / component-level models** — rejected: ~5% more realism
  for ~300% more complexity.
- **Oversampling the nonlinearities** — rejected: multiplies CPU; only worth it
  when the filter is driven hard, which our internal levels don't.
- **Native `DynamicsCompressorNode` / not modelling dynamics at all** — rejected
  for lacking character; see [ADR-002](adr-002-audioworklet-compressor.md).
- **"Academically correct" DSP as the default goal** — rejected: accuracy that is
  not *also* cheap and stable does not serve the instrument.

## Consequences

- **Good:** a consistent, lively feel; cheap enough for 8-voice poly + multiple
  worklet instances in a tab; numerically safe — the worklet DSP is unit-tested
  for boundedness (`tests/audio/compressor-worklet.test.ts`,
  `tests/audio/ladder-filter-worklet.test.ts`); low-level behaviour stays
  compatible, so presets/songs survive tuning changes.
- **Trade-off:** not physically/circuit accurate — don't expect a measured
  Moog/1176 transfer curve. Tuning constants (e.g. the ladder's `RES_MAKEUP` and
  resonance `curve`, the compressors' character) are dialled **by ear**, not
  derived, so changing them is a judgement call, not a bug fix. "Correct"
  improvements (ZDF, oversampling, thermal models) are **deliberately declined**
  unless they are *also* cheap and stable — propose them against this ADR rather
  than adding them silently.

## Note (2026-08-12) — a factual correction, not a change of decision

"Across **8-voice polyphony × 2 channels**" in *Context / Forces* above described
the budget at the time of writing. It has been stale since
[ladder-filter](../features/ladder-filter.md) REQ-9 (v3) pinned the filter worklet
to **one** channel (`channelCount: 1`, `outputChannelCount: [1]`) — forcing it
stereo only computed identical samples twice. The real multipliers today: the
**ladder filter** is one instance per voice at 1 channel; the **compressors** are
two bus instances at 2 channels.

The decision is untouched — a smaller budget than stated argues *for*
*musical, stable, cheap*, not against it. Recorded here rather than edited above,
because ADRs are append-only ([`specs/README.md`](../README.md) → Decisions).
