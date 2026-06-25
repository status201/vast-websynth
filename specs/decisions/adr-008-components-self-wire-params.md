# ADR-008 — Components self-wire their params; Engine coordinates

```yaml
id: adr-008-components-self-wire-params
status: accepted
date: 2026-06-25
deciders: core
related:
  - ../architecture
  - ../recipes/add-a-parameter
  - ../features/effects
  - ../features/compressor
  - ../features/voicing
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

The `Engine` applies every scalar param to the audio graph (REQ-1: UI and audio
never call each other directly). That wiring had accreted into one
`subscribeParams()` method (~200 lines) that named every param id in the
instrument — oscillators, filter, envelopes, LFO, three parallel FX chains, two
compressors, transport, arp, and the lane mixer. Every new feature had to edit
that single method, making it the busiest merge point in the codebase, and the
three structurally identical FX chains (synth / drum / sampler) were each wired
by hand. The `Engine` was trending toward a God object: not because it did the
DSP (that is delegated to `Voice`, the `Effect` classes, and the transport
modules), but because it was the one place that *knew about everything*.

## Decision

Each subsystem **wires its own params**. Concretely:

- Every insert `Effect` exposes `bind(bus, prefix)` (`Compressor` takes the
  index→real-value tables: `bind(bus, prefix, ratios, releases?)`) that
  `bus.subscribe(...)`s its own `on`/`mix`/setter params. `Engine` calls
  `this.distortion.bind(bus, 'fx.dist')` etc. — the same class binds at a
  different prefix for the drum/sampler variants. This replaces the old
  `Engine.subscribeCompressor()` helper and the per-effect subscribe blocks.
- A `chain(input, fx[], output)` helper (`effects/effect.ts`) wires a series of
  effects, so the three FX chains in `Engine`'s constructor are declarative.
- Voice allocation + voicing (poly/mono, unison, glide, analogue drift) lives in
  **`Polyphony`** (`src/audio/polyphony.ts`); the Song-tab mute/solo/volume
  mixer lives in **`LaneMixer`** (`src/audio/lane-mixer.ts`, reusing the pure
  `audibleLanes`). `Engine` keeps thin `playNote`/`releaseNote` that delegate to
  `Polyphony`, preserving the `SynthOutput` surface used by arp/sequencer.

`Engine` still owns the `AudioContext`, the graph topology, the voice pool, and
the transport modules — it is the coordinator, not the knower-of-all-params. The
per-voice params (osc/filter/env, fanned out via the `all()` helper) stay in
`Engine` because they are genuinely engine-owned.

## Alternatives considered

- **Keep one big `subscribeParams()`** — rejected: it is the merge-conflict
  magnet and the friction the `add-a-parameter` recipe codifies; it grows
  linearly with the feature set and duplicates the three FX chains.
- **A central registry/table mapping param-id → setter** — rejected: it moves
  the god-knowledge from a method into a data structure without giving each
  component ownership of its own contract, and it fights TypeScript's
  per-component setter signatures (esp. the compressor's index tables).
- **Add `bind` to the shared `Effect` interface** — rejected: `Compressor.bind`
  needs extra (required) ratio/release table args, which is not assignable to a
  uniform `bind(bus, prefix)`. Effects expose `bind` as a concrete method;
  `Engine` calls them on their concrete types. The minimal `Effect` interface
  (`input`/`output`/`setBypass`) is unchanged.

## Consequences

- **Good:** `subscribeParams()` shrinks dramatically and stops being the gravity
  well; adding an FX param edits only the effect class; the FX chains are
  declarative; voice allocation and the lane mixer are independently unit-testable.
- **Trade-off:** each `Effect` now takes a type-only dependency on `ParamBus`
  (it knows its own param prefix), so "pure audio node" and "param wiring" are no
  longer in separate files. We accept this — the param contract belongs with the
  component that owns it.
- **Note:** this does **not** address the UI's direct reach into Engine
  sub-objects (`engine.patterns`, `engine.clock`, …); that service-locator
  coupling is a separate axis, deliberately left for a future ADR.
```
