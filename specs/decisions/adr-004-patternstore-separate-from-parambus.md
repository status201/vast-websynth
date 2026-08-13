# ADR-004 — PatternStore separate from ParamBus

```yaml
id: adr-004-patternstore-separate-from-parambus
status: accepted
date: 2026-05-15
deciders: core
related:
  - ../architecture
  - ../features/sequencer
  - ../features/song-mode
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

The `ParamBus` ([ADR-001](adr-001-parambus-over-redux.md)) is deliberately
**scalar**: a `ParamDef` is `min/max/default/taper/format`, and `set` clamps a
single number. The step grids — sequencer/drum/sampler patterns — are a different
shape entirely: arrays of `StepSettings` objects (`velocity/gate/prob/ratchet/tie`,
plus `on`/`note`), in 4 banks each, with edit-vs-play-bank semantics. None of
`min/max/clamp/taper` means anything for those, so forcing them through the scalar
bus would distort both.

## Decision

Non-scalar pattern state lives in its own **`PatternStore`**
(`src/state/patterns.ts`) with its own listener mechanism, alongside but separate
from `ParamBus`. It holds the 4 sequencer + 4 drum + 4 sampler banks and the
edit-bank/play-bank distinction the transport reads. (It has since grown the 4
motion banks plus `motionAssigns` / `motionTracks` on the same terms — the
decision generalised exactly as intended; see `features/motion-sequencer.md`.) `Song.capture`/`restore`
snapshots **both** stores together, so a saved song still round-trips as one unit.

## Alternatives considered

- **Encode grids into `ParamBus`** (one param per cell field) — rejected: clamp/
  taper/format are meaningless for grid cells, and it would explode the registry
  with thousands of synthetic param ids that aren't really scalars.
- **One unified generic store for everything** — rejected: it would have to drop
  the scalar domain modelling (`ParamDef`) that makes presets clean and the bus
  self-describing — i.e. it would undo [ADR-001](adr-001-parambus-over-redux.md)
  to absorb grids.

## Consequences

- **Good:** each store fits the data it holds — the bus stays purely scalar and
  snapshot-clean, while `PatternStore` models banks/steps with edit-vs-play
  semantics the transport needs.
- **Trade-off:** there are **two** listener mechanisms to understand, and any
  full-state operation (`Song.capture`/`restore`, reset) must remember to touch
  both stores, not one.
