# ADR-006 — No-op defaults for new parameters

```yaml
id: adr-006-no-op-param-defaults
status: accepted
date: 2026-05-15
deciders: core
related:
  - ../architecture
  - ../features/presets
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

Presets and songs are `ParamBus` snapshots ([ADR-001](adr-001-parambus-over-redux.md)):
a saved sound is a bag of `id → value` pairs that **omits any param it didn't know
about**. When we later add a new param, every existing saved sound loads without a
value for it and falls back to that param's `default`. If the default were a
musically active value, adding the param would silently change how every preset
and demo song that predates it sounds — a back-compat break with no migration
step in a zero-dependency app.

## Decision

Every **new** analogue/song parameter defaults to a **no-op** — a value that
changes nothing versus the behaviour before the param existed: sub level `0`,
unison `1` voice, drift `0`, `djfilter` `0`, `seq.master` `1`, and `glide.mode`
defaults to `always` (glide time `0` then reproduces the pre-glide behaviour). New
sounds opt *in* by moving the control; old sounds, lacking the key, stay identical.

## Alternatives considered

- **"Sensible" musical defaults** (whatever sounds best fresh) — rejected: it
  retroactively alters every existing preset and demo song that omits the key,
  which is exactly the silent regression we must avoid.
- **Per-param versioned migration** — rejected: heavyweight machinery (a migration
  registry, version gates per field) for a no-dependency app, when a chosen-neutral
  default achieves the same back-compat for free.

## Consequences

- **Good:** new params ship without touching the sound of any existing preset or
  demo; no migration code, no version bump needed for additive params.
- **Trade-off:** a param's default is chosen for **compatibility, not for the best
  out-of-the-box sound** — sometimes a fresh patch starts at a deliberately inert
  value that a new user must move to hear the feature.
