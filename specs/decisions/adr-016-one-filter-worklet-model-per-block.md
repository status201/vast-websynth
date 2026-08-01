# ADR-016 — One filter worklet, the model selected per block

```yaml
id: adr-016-one-filter-worklet-model-per-block
status: accepted
date: 2026-08-01
deciders: core
related:
  - ../features/filter-models
  - ../features/ladder-filter
  - ../decisions/adr-010-musical-stable-cheap-dsp
```

> ADR `status` is its own decision lifecycle and is **not** the feature-spec
> `draft | active | implemented`. A decision is `proposed`, then `accepted`; a
> later ADR can mark it `superseded by adr-XXX` or `deprecated`. Records are
> append-only — supersede, don't rewrite.

## Context / Forces

Adding a second, user-selectable filter model ([filter-models.md](../features/filter-models.md))
raised a structural question: does a model get its own worklet, or share one?
The pressure is that the filter is **per-voice** — eight instances live — and
that a great deal of hard-won machinery hangs off the existing node: the
`setActive` idle gate, the block-constant cutoff-coefficient hoist, the `sat()`
carry, and three permanent `AudioParam` connections (`filEnvScale → cutoffNote`,
`lfo.toCutoff → cutoffNote`, plus the base value). Anything that swaps nodes has
to re-make all of that, per voice, on every switch. Pulling the other way: the
repo already has a hot-swap precedent in `DrumMachine.setTrackModel`, and a
single file holding two algorithms is a file that grows.

## Decision

**Both filter models live in `public/worklets/ladder-filter.js` and are selected
by a k-rate `model` AudioParam, with the branch outside the sample loop.**

`process()` reads `params.model[0]` once per render quantum and dispatches to one
of two sample loops. The ladder loop's body is byte-for-byte what it was, so its
output stays bit-identical to the frozen reference that
`tests/audio/ladder-filter-worklet.test.ts` pins — the standard
`runtime-performance.md` REQ-8 bar ("bit-exact or it is a sound change"). The two
models share the four pole states, which mean the same thing in both, so a switch
carries state over as a character crossfade; the ladder's carried saturations are
re-primed on the switching block so its recurrence resumes self-consistent.

Because model selection is an `AudioParam` rather than a `processorOptions` value
or a port message, it is live, sample-scheduled, and per-voice — no message
round-trip, no node lifecycle.

## Alternatives considered

- **A second worklet plus a node hot-swap in `Voice`** (the
  `DrumMachine.setTrackModel` pattern) — rejected: a swap must disconnect and
  re-make `mix → filter → tremolo`, `filEnvScale → cutoffNote` and
  `lfo.toCutoff → cutoffNote` for each of eight voices on every switch, replay
  every cached setter, and add a second `loadModule` to `Engine.init()`. The
  drum precedent gets away with it because a drum voice has **one** output edge
  and no permanently-connected modulation inputs; the filter has three inputs
  summing into one `AudioParam`. All of that to avoid one `if` per block.
- **Both models rendering in parallel, crossfaded** — rejected: the unselected
  model would burn audio-thread CPU on all eight voices forever. This is the same
  force behind [ADR-012](adr-012-true-bypass-disconnects.md) (an idle-but-
  connected subgraph still renders), and the filter already has the cheaper
  in-worklet answer in its `setActive` gate.
- **`processorOptions.mode`, fixed at construction** (the compressor's shape,
  [ADR-002](adr-002-audioworklet-compressor.md)) — rejected: it is decided once
  per node, so changing model would still mean building a new node. The
  compressor gets away with it because its character is a build-time choice; a
  filter model is a knob the player turns.
- **A port message instead of an AudioParam** — rejected: messages are
  asynchronous and unscheduled, so a switch could land mid-block and could not be
  automated. An `AudioParam` costs nothing extra and composes with everything
  else.

## Consequences

- **Good:** the switch is free (one `if` per render quantum, not per sample); the
  idle gate, coefficient hoist and `sat()` carry keep working untouched; no graph
  surgery, no second `addModule`, no new failure mode if a module fails to load;
  the ladder stays provably bit-identical; and a third model is an append to
  `FILTER_MODEL_LABELS` plus one more loop.
- **Trade-off:** one worklet file now holds two algorithms and will hold more, so
  it grows and its shared state array serves both. Duplicated loop bodies are
  deliberate — factoring the common arithmetic into a shared helper would break
  the ladder's bit-exactness guarantee and add a call per sample. Read that
  duplication as load-bearing, not as an invitation to DRY it up.
