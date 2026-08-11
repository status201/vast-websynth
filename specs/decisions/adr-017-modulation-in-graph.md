# ADR-017 — Modulation lives in the audio graph; automation lives on the bus

```yaml
id: adr-017-modulation-in-graph
status: accepted
date: 2026-08-11
deciders: core
related:
  - ../features/mod-matrix
  - ../features/lfo
  - ../features/motion-sequencer
  - ../features/xy-pad
  - ../features/runtime-performance
```

> ADR `status` is its own decision lifecycle and is **not** the feature-spec
> `draft | active | implemented`. A decision is `proposed`, then `accepted`; a
> later ADR can mark it `superseded by adr-XXX` or `deprecated`. Records are
> append-only — supersede, don't rewrite.

## Context / Forces

By the time a modulation matrix was proposed, this app already had **two** ways to make a
parameter move, built for different jobs and never named as such:

- **In the audio graph.** The LFOs, both envelopes, pitch bend and drift are `GainNode`s and
  `ConstantSourceNode`s connected into summing `AudioParam`s. Summation is native and happens on
  the audio thread; [ADR-005](adr-005-cutoff-as-midi-note.md) exists precisely to make that
  summation musical (cutoff carries a MIDI note number so modulators add in semitones).
- **On the `ParamBus`.** The motion sequencer and the XY Pad call `bus.set(id, fromNorm(...))`
  on a capped-fps loop, reaching **any** registered param — over two hundred of them.

A matrix could be built either way, and the two look interchangeable from a feature list. They
are not. A bus-side matrix reaches every parameter but costs a main-thread write per route per
frame, and it duplicates machinery `MotionMachine` already has. A graph-side matrix is free and
sample-accurate but can only address parameters that have a real `AudioParam` behind them.

Deciding case-by-case would produce a third system overlapping the two, and each new modulator
would re-litigate the question.

## Decision

**Modulation is a graph concern; automation is a bus concern. The boundary is whether the
destination has a real `AudioParam`.**

- **Modulation** — continuous, audio-rate, from a *signal source* (LFO, envelope, velocity, key,
  random) into a **summing `AudioParam`**. Implemented as one `GainNode` per route, fanned to the
  voices by the `connectLfoToVoice` idiom in `engine.ts`; depth is a scalar on that gain. The
  graph is edited only when the player re-patches a row, and then only while the gain is ramped
  to zero — never per frame, per tick or per note ([mod-matrix](../features/mod-matrix.md)
  REQ-1). This is `mod-matrix.md`.
- **Automation** — stepped or gestural, at the perf tier's 15/30/60 fps, from a *timeline or
  gesture* (motion lanes, XY Pad, Tape Stop) into **any registered param** via
  `bus.set` under `withoutChangeSignal` ([runtime-performance](../features/runtime-performance.md)
  REQ-5). This is `motion-sequencer.md` and `xy-pad.md`.

A destination that is not an `AudioParam` is therefore **not offered by the matrix** — the
`pulse` destination is the worked example: it has no node, it is a 240 Hz `setPeriodicWave` write,
and so it stays *arbitrated* (lowest source index wins, `lfo.md` REQ-14) rather than summed.

## Alternatives considered

- **A bus-side matrix reaching every registered param** — rejected: eight routes at 60 fps is ~480
  main-thread writes per second, each fanning out through the per-param listener chain. That is
  the cost [runtime-performance](../features/runtime-performance.md) REQ-5/REQ-6 exist to bound,
  and the motion sequencer's REQ-18 records what it looked like the last time this loop was hot
  enough to matter (it starved the autosave debounce entirely). It also re-implements the motion
  sequencer's job with a different UI.

- **Give `ParamBus` a `base` vs `effective` split, and route everything through it** — rejected,
  and this is the alternative most worth recording because it is the attractive one. It appears
  to unify modulation, the XY Pad's spring-back `pre` and the motion sequencer's `baselines` into
  one concept. It cannot: modulation for audio-rate destinations never passes through the bus at
  all, so `effective` would have to be **recomputed on the main thread at frame rate** — the exact
  cost the graph-side design avoids — and it would still be wrong, because envelopes and velocity
  are **per-voice**: eight sounding voices have eight different modulation values, and the bus has
  one slot per id. The result would be two sources of truth for one sum, with the bus's copy
  structurally unable to agree with the audio thread. The *real* defect underneath — that the XY
  Pad, the motion sequencer and Tape Stop keep three uncoordinated restore caches over one slot
  (`motion-sequencer.md` Pitfalls: *"Dragging an automated knob mid-play: motion wins on its next
  write"*) — is an **automation** problem and is left to be fixed as one.

- **Per-voice LFOs, so every source is per-voice and the split disappears** — rejected: it makes
  every source cost ×8 oscillators, and `lfo.md` already records global LFOs as a deliberate
  design ("a per-voice LFO would be a separate feature with its own params").

- **Let each route choose its own lane (graph if possible, bus otherwise)** — rejected: the lane
  would be invisible in the UI while determining latency, CPU cost and whether the route is
  per-voice. Two routes that look identical would behave differently, which is
  [ADR-014](adr-014-dont-make-me-think.md) law 2 inverted.

## Consequences

- **Good:** the matrix costs **nothing** per frame on the main thread — a route is one `GainNode`
  and native `AudioParam` summation. It is sample-accurate, it inherits the bounds and the
  semitone/cent units the existing modulators already established, and it needs no new machinery:
  the graph has been statically wired since boot, and routing has always been a scalar.
- **Good:** the two systems stop competing for the same conceptual space. "Should this be a
  matrix route or a motion lane?" now has an answer that does not depend on taste.
- **Trade-off:** the matrix's destination list is **curated, and shorter than the param list** —
  roughly seven targets against the registry's two hundred plus. A player who wants to
  modulate `fx.delay.mix` must reach for
  a motion lane instead, and the UI has to make that discoverable rather than looking like a
  missing feature.
- **Trade-off:** sources are split into **global** and **per-voice**, and the combination
  "per-voice source → bus-wide destination" is not well defined (eight envelopes into one panner).
  The matrix must forbid it explicitly rather than let it sum to mush — a rule that would not
  exist in a bus-side design.
- **Trade-off:** adding a destination is no longer free — it requires an `AudioParam` to exist,
  and adding one to a worklet costs a per-sample path there.
