# ADR-002 — A custom AudioWorklet compressor over the native node

```yaml
id: adr-002-audioworklet-compressor
status: accepted
date: 2026-05-15
deciders: core
related:
  - ../features/compressor
  - ../recipes/add-an-audioworklet
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

The drum bus and the master bus each want a compressor with **recognisable
hardware character** — a 1176-style FET on the drums and an SSL-G-style VCA "glue"
on the master. That character comes from specific behaviours: a feedback detector,
program-dependent / auto release, a soft knee, FET saturation, and "all buttons
in" — plus a gain-reduction tap to drive a UI meter. Web Audio's built-in
`DynamicsCompressorNode` exposes one fixed feed-forward algorithm with none of
those, and we don't model dynamics in the time domain anywhere else.

## Decision

We ship a single `hardware-compressor` **AudioWorklet**
(`public/worklets/compressor.js`) with two character modes fixed per instance via
`processorOptions.mode` (`'fet'` heads the drum chain, `'vca'` sits on the
master). The worklet's DSP runs on the audio thread; it posts gain reduction (dB,
~31 Hz) on its `port` for the `GrMeter`. Because an `AudioWorkletNode` can't be
created until its module is loaded (async) but `Engine`'s constructor wires the
graph synchronously, the `Compressor` effect builds a `BypassWrapper`
synchronously and `attachWorklet()` splices the real node in after `loadModule`,
replaying cached setter values. Full contract in
[`features/compressor`](../features/compressor.md).

## Alternatives considered

- **`DynamicsCompressorNode`** — rejected: one opaque, fixed algorithm; no
  feedback detection, no auto/program-dependent release, no saturation, and no way
  to read instantaneous gain reduction for a meter.
- **`ScriptProcessorNode`** — rejected: deprecated, and it runs DSP on the **main
  thread**, so it glitches under UI load — the exact thing AudioWorklet exists to
  fix.
- **`WaveShaper` + envelope follower** — rejected: a `WaveShaper` is a static
  transfer curve with no time-domain dynamics; reconstructing a real detector +
  gain stage around it is just an AudioWorklet with extra steps.

## Consequences

- **Good:** full control of the DSP and authentic character; the processor is
  **unit-testable directly** under Vitest by stubbing the worklet globals
  (`tests/audio/compressor-worklet.test.ts`); the `port` cleanly feeds the meter.
- **Trade-off:** an async load/attach lifecycle (`loadModule` →
  `attachWorklet()` → replay setters) and a `BypassWrapper` placeholder, which the
  whole engine init is shaped around. This is the canonical pattern for any
  worklet-backed node — see [`recipes/add-an-audioworklet`](../recipes/add-an-audioworklet.md).
