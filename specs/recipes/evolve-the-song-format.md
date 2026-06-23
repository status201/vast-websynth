# Recipe — evolve the song format (versioning)

```yaml
id: evolve-the-song-format
status: implemented
version: 1
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
older files forever. The format already did this once (`version: 1 → 2` added
optional sampler fields). The contract: **additive, optional, defaulted** — never
required, never repurposed.

## Steps (going from v2 → v3)

### 1. Extend `SongFile` with OPTIONAL fields — `src/state/song.ts`

```ts
export interface SongFile {
  // …
  version: 1 | 2 | 3;
  myNewThing?: SomeShape;     // optional, so v1/v2 files still satisfy the type
}
```

### 2. Bump the version `capture()` writes

`Song.capture(...)` always writes the latest (`version: 3`).

### 3. Keep `fromJSON` permissive

`Song.fromJSON` only checks `format === 'websynth-song'` + `params` + `seqBanks` +
`drumBanks` — leave it version-agnostic so every version parses.

### 4. Read new fields with fallbacks in `apply()`

`Song.apply` already does `bus.resetDefaults()` then `bus.restore(file.params)`
(so params an old file omits revert to defaults). Read your new field with a
default:

```ts
applyMyNewThing(file.myNewThing ?? DEFAULT_MY_NEW_THING);
```

### 5. New step-cell fields → defaults under

If you add a field to a step cell, add it to `StepSettings` /
`TRIGGER_CELL_DEFAULTS` (`patterns.ts`). `PatternStore.restore` spreads defaults
**under** incoming cells (`Object.assign(dst, DEFAULTS, cell)`), so legacy cells
gain the field and sound unchanged.

## Gotchas

- **Never** make a new field required, and **never** remove or repurpose an existing
  field's meaning — that breaks old files.
- Add a regression test that applies a `v2` (and `v1`) fixture under the new code.

## Acceptance (BDD)

```gherkin
Scenario: An old file still loads under the new version
  Given a version: 2 SongFile without the v3 field
  When apply() runs on v3 code
  Then it parses, the v3 field uses its default, and v1/v2 content is unchanged
# pinned by: tests/state/song.test.ts (v1/v2 apply cases)
```

## Tests & verification

- `tests/state/song.test.ts` (extend with a prior-version fixture),
  `tests/state/patterns.test.ts`. `npm test` / `npm run typecheck`.
