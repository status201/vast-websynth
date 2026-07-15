# ADR-007 — SongFile additive versioning

```yaml
id: adr-007-songfile-additive-versioning
status: accepted
date: 2026-05-15
deciders: core
related:
  - ../features/song-mode
  - ../recipes/evolve-the-song-format
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

Songs persist as JSON — both in `localStorage` slots (`websynth.song.*`) and as
exported files users keep on disk — and the built-in `DEMO_SONGS` are
hand-authored `SongFile` literals. All of those must **keep loading, and keep
sounding identical, forever**: a user's saved song from an old build can't become
unreadable when the app grows a new subsystem (the sampler was added after the
first song format existed). No-op param defaults
([ADR-006](adr-006-no-op-param-defaults.md)) handle new *scalars*, but new
*structural* sections (whole banks/chains) need a format story too.

## Decision

The `SongFile` format grows **additively** behind a `version` discriminator
(`version: 1 | 2`). v2 adds *optional* `samplerBanks` / `samplerChain` /
`sampleNames`; `Song.fromJSON` accepts both versions unchanged, and
`PatternStore.restore` spreads defaults under incoming cells so a v1 file's plain
`{on, velocity}` drum/sampler cells gain `gate: 1` etc. and sound unchanged. New
fields are always optional and defaulted — never required — so old files load and
new files degrade gracefully. The procedure is captured in
[`recipes/evolve-the-song-format`](../recipes/evolve-the-song-format.md).

## Alternatives considered

- **Breaking schema bumps** (require the new shape) — rejected: it orphans every
  saved song and exported file from before the bump, and breaks the `DEMO_SONGS`
  literals.
- **No version field at all** — rejected: without a discriminator the loader can't
  tell an old file from a new one, so it can't know which fields to default vs
  trust — robust back-compat becomes guesswork.

## Consequences

- **Good:** songs saved by any past build keep loading and sounding the same; one
  `fromJSON` path handles every version; demos stay as plain literals.
- **Trade-off:** new structural fields must always be **optional + defaulted**,
  never required — the format can only grow, and a removed/renamed field needs a
  new version that still reads the old one (see the recipe).

> **Follow-up (2026-07-07):** v3 applied this same contract — the optional `xy`
> field (XY Pad axis assignment, [`features/xy-pad`](../features/xy-pad.md));
> v1/v2 files keep loading with default axes. The decision is unchanged.

> **Follow-up (2026-07-15):** v4 applied it again — the optional `motionBanks` /
> `motionAssigns` / `motionChain` fields
> ([`features/motion-sequencer`](../features/motion-sequencer.md)); v1–v3 files
> keep loading with empty motion state (and `motion.on` defaults to 0, so
> nothing is written). The decision is unchanged.
