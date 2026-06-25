# ADR-001 — ParamBus over a state framework (Redux/Zustand)

```yaml
id: adr-001-parambus-over-redux
status: accepted
date: 2026-05-15
deciders: core
related:
  - ../architecture
  - ../recipes/add-a-parameter
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

Every scalar parameter (oscillator mix, filter cutoff, FX amounts, …) needs a
single home so that the UI and the audio graph agree on its value, presets/songs
can snapshot it, and it can be clamped to a valid range. The defining constraint
is the hard **UI/audio separation** (`architecture.md` REQ-1): a knob must not
call into the `Engine`, and the `Engine` must not read the DOM. We also commit to
**zero runtime dependencies** (see [ADR-003](adr-003-no-runtime-dependencies.md)),
so a generic state library is off the table on principle as well as on need.

## Decision

We use one hand-rolled **`ParamBus`** (`src/state/params.ts`) as the single source
of truth for every scalar. Each param is registered once in `registerDefaults()`
with `min/max/default` (+ optional `taper`/`format`); `bus.set(id, v)` clamps and
notifies, the UI writes via `set`, and the `Engine` reads via `subscribe`. Presets
and songs are then a trivial `bus.snapshot()` / `restore()`. The audio-domain
modelling (range, taper, formatting) lives *in the param definition*, which a
generic store would not give us.

## Alternatives considered

- **Redux / Zustand / a generic store** — rejected: a runtime dependency we won't
  take, and it models opaque values, not audio params — no built-in
  clamp/taper/format, so we'd re-implement `ParamDef` on top of it anyway.
- **Direct UI→audio calls** (knob holds a node reference) — rejected: couples the
  two layers, makes the audio graph untestable without the DOM, and there's no one
  place to snapshot for presets/songs.
- **A bare event emitter** — rejected: gives notification but no *single source of
  truth* and no snapshot/restore; every consumer would cache its own copy.

## Consequences

- **Good:** UI and audio are reasoned about independently and tested separately
  (the bus is pure logic, unit-tested in jsdom); presets/songs are one snapshot
  call; clamping/formatting is centralised.
- **Trade-off:** every new param must be registered by hand in
  `registerDefaults()` and wired in `Engine.subscribeParams()` — the three-edit
  dance in [`recipes/add-a-parameter`](../recipes/add-a-parameter.md). That
  boilerplate is the price of the domain modelling.
