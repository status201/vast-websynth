# ADR-009 — The UI depends on a StudioApi facade, not the concrete Engine

```yaml
id: adr-009-ui-depends-on-studio-api-facade
status: accepted
date: 2026-06-25
deciders: core
related:
  - ../architecture
  - adr-008-components-self-wire-params
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

The hard UI/audio separation (architecture REQ-1) only governs *scalar params*:
the UI writes them via `ParamBus.set` and the `Engine` applies them via
`subscribe`. Everything else — transport, pattern grids, the recorder, GR meters,
sample decoding — had no such contract. Panels were handed the **whole `Engine`**
and reached into its sub-objects directly (`engine.patterns`, `engine.clock`,
`engine.perf`, `engine.recorder`, `engine.drumComp`, `engine.ctx`, …) across ~12
signature sites. The UI was welded to Engine's field layout: any change to those
internals (the kind ADR-008 just made — extracting `Polyphony`/`LaneMixer`) risks
the UI, and nothing stopped a panel from reaching into a *new* internal.

## Decision

The UI depends on a curated **`StudioApi`** interface (`src/ui/studio-api.ts`),
not the concrete `Engine`. It exposes only the collaborators the UI actually
uses — the transport modules (`patterns`, `arrangement`, `clock`, `perf`, `seq`,
`drums`, `sampler`, `motion`), the capture controllers (`recorder`,
`bankRender`), sync (`sync`, `rtcSync`), the analysers (`analyser`,
`analyserL`/`analyserR`), `ctx`, `drumComp`/`masterComp`, the read-only
diagnostics (`iosAudio`, `mediaSession`, `backgroundAudio`) and the few verbs
(`panic()`, `resume()`, `seekTo()`, `canSeek()`) — and nothing beyond that
(`voices`, `lfo`, `polyphony`, `laneMixer`, the bus nodes, `subscribeParams`,
`init` stay invisible). The list grows as the UI needs a collaborator; what the
ADR forbids is exposing `Engine` itself.

Every UI signature site (`mountApp`, `installShortcuts`, the four panel builders,
`openRecordSoundModal`, the `TourCtx.engine` field) takes `engine: StudioApi`.
The **UI owns the interface** (dependency inversion); `Engine` satisfies it
**structurally** — there is no `class Engine implements StudioApi`, so `src/audio`
never imports `src/ui`. The structural check fires at the seam in `main.ts`, where
the concrete `Engine` is passed to `mountApp`/`installShortcuts`; if `Engine` ever
drops a member the facade needs, those call sites fail to typecheck. This is a
type-only refactor — zero runtime change.

## Alternatives considered

- **Keep passing the whole `Engine`** — rejected: the unbounded coupling we are
  removing; the UI can reach any internal and is welded to the field layout.
- **`class Engine implements StudioApi`** — rejected: it would force `src/audio`
  to import the UI-owned interface, inverting the dependency the wrong way.
  Structural satisfaction (checked at the `main.ts` call sites) gives the same
  guarantee with no audio→ui edge.
- **Per-collaborator narrow interfaces** (e.g. `TransportView`, `MeterSource`
  exposing only the methods the UI calls) — rejected for now: 6–8 extra types and
  mapping for marginal gain, since the UI already calls cohesive collaborator
  APIs. The single-interface facade is the right size for a vanilla-TS app.
- **A runtime wrapper object** (a `Studio` class built in `main.ts` with intentful
  methods like `decodeAudio()`/`toggleTransport()`) — rejected: a new runtime
  layer and more edits, when a type-level facade already enforces the boundary.

## Consequences

- **Good:** the UI/audio boundary for non-param interactions is now an enforced,
  documented contract; Engine internals can be restructured (as in ADR-008) as
  long as `Engine` still satisfies `StudioApi`; a panel can no longer reach into a
  new internal by accident.
- **Trade-off:** collaborators are exposed *whole* (e.g. the UI's `clock` is the
  full `Clock`, so `clock.setBpm` is technically reachable even though params
  should flow through the bus). Tightening per-method is deferred to the
  per-collaborator-interface option above if it ever proves necessary.
- **Note:** the dev-only `window.__synth.engine` bridge stays the concrete
  `Engine` (E2E reads deeper state through it); `src/audio/midi.ts` keeps `Engine`
  since it is the audio layer, not UI.
```
