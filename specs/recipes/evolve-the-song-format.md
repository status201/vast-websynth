# Recipe — evolve the song format (versioning)

```yaml
id: evolve-the-song-format
status: implemented
version: 2
owner: core
related:
  - song-mode
  - step-settings
source:
  - src/state/song.ts                    # SongFile, capture/apply/fromJSON
  - src/state/patterns.ts                # PatternStore.restore, TRIGGER_CELL_DEFAULTS
```

How to add fields / a new `version` to the song format **without breaking existing
saved songs or demos**. This is the load-bearing backward-compatibility playbook.

## Background / Why

Users save song files and demos ship as data, so the load path must keep parsing
older files forever. The format already did this twice (`version: 1 → 2` added
optional sampler fields; `2 → 3` added the optional [XY Pad](../features/xy-pad.md)
`xy` axis assignment). The contract: **additive, optional, defaulted** — never
required, never repurposed.

## Steps (going from v3 → v4)

### 1. Extend `SongFile` with OPTIONAL fields — `src/state/song.ts`

```ts
export interface SongFile {
  // …
  version: 1 | 2 | 3 | 4;
  myNewThing?: SomeShape;     // optional, so v1/v2/v3 files still satisfy the type
}
```

### 2. Bump the version `capture()` writes

`Song.capture(...)` always writes the latest (`version: 4`). If the new field lives
in its own store (like `xy`), thread it in as an optional `capture(...)` arg and
include it only when passed, mirroring the `xy` precedent.

### 3. Keep `fromJSON` permissive

`Song.fromJSON` only checks `format === 'websynth-song'` + `params` + `seqBanks` +
`drumBanks` — leave it version-agnostic so every version parses.

### 4. Read new fields with fallbacks in `apply()`

`Song.apply` already does `bus.resetDefaults()` then `bus.restore(file.params)`
(so params an old file omits revert to defaults). Read your new field with a
default (the `xy` field does `xyStore?.set(file.xy ?? XY_DEFAULT_ASSIGN)`):

```ts
applyMyNewThing(file.myNewThing ?? DEFAULT_MY_NEW_THING);
```

### 4b. Let it survive the compaction boundary + validator + schema

Three more places must learn the field or it is silently dropped / rejected:

- `compactSongForExport` (`src/state/serialize.ts`) — copy the field through when
  present (it drops unknown keys), else it never reaches disk.
- `validateSongFile` (`src/state/song-validate.ts`) — widen the `version` set and
  validate the new field **only when present** (path-prefixed message), so older
  files still pass.
- `public/schema/websynth-song.schema.json` — bump `version.enum` and add the
  optional property (docs/tooling mirror). Also update the version literals in the
  `buildSongPrompt` copy (`src/ui/components/ai-prompt.ts`).

### 5. New step-cell fields → defaults under

If you add a field to a step cell, add it to `StepSettings` /
`TRIGGER_CELL_DEFAULTS` (`patterns.ts`). `PatternStore.restore` spreads defaults
**under** incoming cells (`Object.assign(dst, DEFAULTS, cell)`), so legacy cells
gain the field and sound unchanged. The export side mirrors this: the
default-sparse serializer (`compactSongForExport`, `src/state/serialize.ts`) drops
the field whenever it equals the default — so teach the matching `compact*Cell`
helper about it (and decide whether it's safe to drop for the **seq** shape, whose
`restore` only spreads `SEQ_EXTRA_DEFAULTS`). See
[ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md).
After changing the format, re-run `npm run clean:demos`.

## Gotchas

- **Never** make a new field required, and **never** remove or repurpose an existing
  field's meaning — that breaks old files.
- Add a regression test that applies a `v2` (and `v1`) fixture under the new code.

## Scenarios (BDD)

```gherkin
Scenario: An old file still loads under the new version
  Given a prior-version SongFile without the new field
  When apply() runs on the new code
  Then it parses, the new field uses its default, and prior content is unchanged
# pinned by: tests/state/song.test.ts (v1/v2/v3 apply cases)
```

## Tests & verification

- `tests/state/song.test.ts` (extend with a prior-version fixture),
  `tests/state/patterns.test.ts`. `npm test` / `npm run typecheck`.
