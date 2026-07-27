# ADR-013 — The song *authoring dialect* is input-only (never persisted or exported)

```yaml
id: adr-013-authoring-dialect-input-only
status: accepted
date: 2026-07-12
deciders: core
related:
  - ../features/song-authoring-dialect
  - ../features/ai-prompt
  - adr-007-songfile-additive-versioning
  - adr-011-export-precision-and-default-sparse-serialization
```

## Context / Forces

A canonical `SongFile` requires literal `seqBanks[4][16]` + `drumBanks[4][8][16]`
grids — 576+ cells even for a two-bar loop. That is thousands of output tokens,
and in practice only the strongest LLMs reliably emit one: weaker agents truncate
mid-array or refuse to commit to the file at all. We want *any* AI agent (and
terse humans) to author working songs. At the same time, the canonical format is
load-bearing: ADR-007 (additive versioning) and ADR-011 (canonical compact
export) both reason about **one** on-disk format, and every export/save surface
(`Song.toJSON`, save slots, project zips, committed demos) depends on that.

## Decision

Introduce a second, **input-only** format — `format: "websynth-song-author",
version: 1` — that `Song.parse` detects and expands into a canonical
`SongFile` (v3 at the time of this decision; the expander targets the **lowest**
canonical version that can hold what was authored, so a file using no newer field
still expands to that same v3 — see
[`features/song-authoring-dialect`](../features/song-authoring-dialect.md) REQ-12)
(via `expandAuthorSong` in `src/state/song-author.ts`) *before*
`validateSongFile` runs. The dialect is a compression of intent: positional note
lists, drum hit-lists keyed by track name, chain strings like `"AABA"`. Nothing
in the app ever *writes* the dialect — `Song.capture`/`toJSON`, save slots,
project zips, and demos stay canonical-only. The moment an author file crosses
the import boundary it ceases to exist.

## Alternatives considered

- **Make the canonical format itself sparser** (e.g. optional banks, hit-lists in
  `SongFile`) — rejected: it would fork every consumer (`PatternStore.restore`,
  `validateSongFile`, the schema, serialize.ts, all demos) and break ADR-007's
  "the format only grows additively" contract for zero benefit to existing files.
- **A converter tool outside the app** (script/website that expands author →
  canonical) — rejected: an extra manual step for the user, and every ingest
  surface (Import button, launchQueue, URL ingest, MCP) would need its own
  wiring. One branch in `Song.parse` covers them all.
- **Accepting the dialect in exports too** ("round-trip" both formats) —
  rejected: two persisted formats means two versioning stories, two schemas to
  keep back-compatible forever, and ambiguity about what a `.websynth.json` *is*.
  Input-only keeps the persistence story exactly as ADR-007/ADR-011 left it.

## Consequences

- **Good:** any agent that can emit ~40 lines of JSON can author a working song;
  every import surface (file, OS launch, project zip, share URL, MCP) gains the
  ability for free through the single `Song.parse` funnel.
- **Good:** the canonical format, its schema, and both ADRs are untouched — the
  dialect can evolve (or be dropped) without a migration.
- **Trade-off:** a second schema + expander to maintain; format changes now touch
  `song-author.ts`, its schema, and the authoring guide as well (see
  `recipes/evolve-the-song-format.md`).
- **Trade-off:** expansion is lossy in reverse — you cannot recover the compact
  authoring form from a canonical file, and we deliberately never try.
