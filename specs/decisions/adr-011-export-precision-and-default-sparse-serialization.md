# ADR-011 — Export precision & default-sparse serialization

```yaml
id: adr-011-export-precision-and-default-sparse-serialization
status: accepted
date: 2026-06-28
deciders: core
related:
  - ../features/song-mode
  - ../features/presets
  - ../recipes/evolve-the-song-format
```

> ADR `status` is its own decision lifecycle (`proposed | accepted | superseded
> by adr-XXX | deprecated`), distinct from a feature spec's lifecycle.

## Context / Forces

Songs and presets persist as JSON. Knob/slider drags map a 0..1 position back
through the taper to an arbitrary-precision float (`taper.fromNorm`), so an
exported `SongFile` is full of needless digits — `sub.level: 0.330909194946289`,
`filter.cutoff: 60.03635787963867` — none of it audible (the UI itself shows ~2
significant figures; levels render as whole percent). Worse, the bulk of a file is
thousands of **identical default step-cells** (`{on:false,velocity:0.85,gate:1,
prob:1,ratchet:1,tie:false}`) across the seq/drum/sampler grids. We want smaller,
cleaner files without changing how anything sounds — *musical-stable-cheap*
([ADR-010](adr-010-musical-stable-cheap-dsp.md)) applied to persistence — and one
implementation, not three.

## Decision

Optimize **only at the serialization boundary**: `Song.toJSON` runs a single pure
helper, `compactSongForExport` (`src/state/serialize.ts`), that (a) rounds every
number to **4 significant figures** (`Number(n.toPrecision(4))`) and (b) writes
**default-sparse cells** — emitting only the fields that differ from the cell's
defaults. Live `ParamBus`/`PatternStore` state stays full-precision; `bus.set` is
**not** quantized. Sparse cells ride the existing additive-loader contract
([ADR-007](adr-007-songfile-additive-versioning.md)): the validator and JSON Schema
already make per-step fields optional, and `PatternStore.restore` already spreads
defaults under incoming cells, so a sparse `{on:false}` expands back identically.

Significant-figure rounding (not fixed decimals) preserves tiny exp-taper values
(`comp.attack 0.00003025`, never `0`). The sparse rules are **asymmetric**, set by
how `restore` re-expands each machine: drum/sampler cells spread the full
`TRIGGER_CELL_DEFAULTS`, so they keep only `on` and drop every other default field;
seq `restore` spreads only `SEQ_EXTRA_DEFAULTS = {prob,ratchet,tie}` and `apply`
does not reset the store first, so a seq step must always keep `on`/`note`/
`velocity`/`gate` and may drop only default `prob`/`ratchet`/`tie`. The
`download()` file is pretty-printed (2-space + trailing newline), byte-identical
to `npm run clean:demos` output so exports drop into `src/state/demos/` with
readable diffs; localStorage/project-zip/share-link stay compact whitespace. Preset
`save` reuses `roundParams` (presets have no cells).

## Alternatives considered

- **Quantize values in `bus.set` (round at runtime)** — rejected: zero performance
  benefit (DSP cost is per-sample, independent of a float's mantissa — a worklet
  processes `0.3309` and `0.330909` identically), and it changes the live
  instrument's knob response and ripples through the param/taper unit tests. All
  downside for the stated goal, which is about persisted files, not live state.
- **Fixed decimal places (e.g. round to 1e-4)** — rejected: it collapses small
  exp-taper params to `0` (an attack of `0.00003` → `0`), a real behavioural change.
- **Omit params equal to their default too** — rejected (for now): the params block
  is a small fraction of file size, and dropping defaults makes a *future* default
  change silently shift old songs. Cells are ~95% of the bloat; stop there.
- **Round inside `capture()` / `snapshot()`** — rejected: it would mutate restored
  live state on save and muddy the honest `SeqStep[][]`/`Snapshot` types; the
  serialization boundary is the single correct place.

## Consequences

- **Good:** dramatically smaller files (dead cells become `{on:false}`); no audible
  change; one pure helper shared by song export, preset export, and the demo-cleanup
  script (DRY); no validator/schema change needed (the additive contract already
  covered it).
- **Trade-off:** `toJSON` is no longer byte-identical to its input — it is the
  *canonical compact* form, so `fromJSON(toJSON(x))` equals `compactSongForExport(x)`,
  not `x`. The round-trip unit tests assert that canonical-inverse relationship
  instead of raw deep-equality. Re-tuned demos must be re-canonicalized with
  `npm run clean:demos`.
```
