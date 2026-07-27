# Recipe — evolve the song format (versioning)

```yaml
id: evolve-the-song-format
status: implemented
version: 4   # v4: rebased on v6 -> v7 (it still walked v4 -> v5); SONG_VERSION and
             #     KNOWN_SONG_VERSIONS now live in one pure module; llms.txt and the
             #     authoring-docs pin are named in the checklist
owner: core
related:
  - song-mode
  - step-settings
  - song-authoring-dialect
source:
  - src/state/song-version.ts            # SONG_VERSION + KNOWN_SONG_VERSIONS (the one constant)
  - src/state/song.ts                    # SongFile, capture/apply/fromJSON
  - src/state/patterns.ts                # PatternStore.restore, TRIGGER_CELL_DEFAULTS
  - src/state/song-author.ts             # the authoring dialect's version ladder
  - public/llms.txt                      # advertises the canonical version to crawling agents
```

How to add fields / a new `version` to the song format **without breaking existing
saved songs or demos**. This is the load-bearing backward-compatibility playbook.

## Background / Why

Users save song files and demos ship as data, so the load path must keep parsing
older files forever. The format already did this **five** times (`version: 1 → 2`
added optional sampler fields; `2 → 3` the optional [XY Pad](../features/xy-pad.md)
`xy` axis assignment; `3 → 4` the optional
[motion sequencer](../features/motion-sequencer.md) fields; `4 → 5` its
`motionTracks`; `5 → 6` the [sequencer](../features/sequencer.md)'s `seqTracks`).
The contract: **additive, optional, defaulted** — never required, never repurposed.

## Steps (going from v6 → v7)

### 1. Bump the one constant — `src/state/song-version.ts`

```ts
export const SONG_VERSION = 7;
```

`KNOWN_SONG_VERSIONS` derives from it (`1..SONG_VERSION`), so the validator, the
published schema pin and the authoring guide all move with this single edit. The
module is deliberately **pure and import-free** so `authoring-guide.ts` and the
MCP bundle can read it without pulling in `song.ts`'s `import.meta.glob`.

### 2. Widen the `SongFile` union + add OPTIONAL fields — `src/state/song.ts`

```ts
export interface SongFile {
  // …
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7;   // hand-maintained: TS can't derive it from a number
  myNewThing?: SomeShape;               // optional, so v1..v6 files still satisfy the type
}
```

`Song.capture(...)` already writes `SONG_VERSION`, never a literal — nothing to do
there. If the new field lives in its own store (like `xy`), thread it in as an
optional `capture(...)` arg and include it only when passed, mirroring the `xy`
precedent.

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

### 4b. Let it survive the compaction boundary + validator + the published docs

Four more places must learn the field or it is silently dropped / rejected / or the
docs go stale (they fell a version behind **twice** — song-mode.md REQ-2):

- `compactSongForExport` (`src/state/serialize.ts`) — copy the field through when
  present (it drops unknown keys), else it never reaches disk.
- `validateSongFile` (`src/state/song-validate.ts`) — validate the new field **only
  when present** (path-prefixed message), so older files still pass. The `version`
  set needs no edit: it reads `KNOWN_SONG_VERSIONS` from step 1.
- `public/schema/websynth-song.schema.json` — bump `version.enum`, extend the
  `version.description`'s "capture() always writes N" sentence, and add the optional
  property (docs/tooling mirror).
- `public/llms.txt` — the `websynth-song` bullet names the canonical version and
  what the newest versions added; it is what crawling agents read.

`src/state/authoring-guide.ts` (which `buildSongPrompt` and the MCP
`get_song_format` tool both serve) interpolates `SONG_VERSION`, so its version
literals move on their own — but its TOP-LEVEL SHAPE still needs a
`// ---- v7 …, OPTIONAL ----` block describing the new field.

**`tests/state/authoring-docs.test.ts` is the backstop for this whole step**: it
pins the schema enum, the schema description, `llms.txt` and every canonical
example in the authoring guide to `SONG_VERSION`. If you skip a bullet here, that
suite fails — trust it rather than your memory of this list.

### 4c. Teach the authoring dialect the new field

The compact author format ([song-authoring-dialect.md](../features/song-authoring-dialect.md))
expands to the **lowest** canonical version that can hold what was authored — *not*
the latest (its REQ-12) — so a format change usually touches it too:

- `src/state/song-author.ts` — accept/expand the new field (or deliberately leave
  it canonical-only and reject it with a clear error). If you do accept it, add a
  **new top rung** to the version ladder (`… ? 7 : <the old ladder>`); never
  replace an existing rung with `SONG_VERSION`, or every simple author song
  silently jumps version and old expectations break.
- `public/schema/websynth-song-author.schema.json` — mirror the dialect change;
  `tests/state/authoring-docs.test.ts` pins its dimensions against `patterns.ts`.
- `src/state/authoring-guide.ts` — document it in the COMPACT AUTHOR FORMAT
  section (the prompt + MCP guide come from here).

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
- **Never hardcode the canonical version** anywhere but `song-version.ts` and the
  `SongFile` union. Both drift sites this recipe has actually suffered were literals:
  the authoring guide's example block, and the MCP `expand_song` tool description
  (which agents read). Interpolate `SONG_VERSION`, or don't name a version at all.
- Committed demos keep the version they were saved at (1..6 today) — that spread is
  the backward-compat coverage, not drift. Don't "fix" it; `npm run clean:demos`
  re-canonicalizes content, not versions.

## Scenarios (BDD)

```gherkin
Scenario: An old file still loads under the new version
  Given a prior-version SongFile without the new field
  When apply() runs on the new code
  Then it parses, the new field uses its default, and prior content is unchanged
# pinned by: tests/state/song.test.ts (v1/v2/v3 apply cases)

Scenario: The published docs never fall behind the constant
  Given SONG_VERSION was bumped but a doc still names the old version
  When the suite runs
  Then tests/state/authoring-docs.test.ts fails, naming the stale artifact
# pinned by: tests/state/authoring-docs.test.ts ('the published canonical version')
```

## Tests & verification

- `tests/state/song.test.ts` (extend with a prior-version fixture),
  `tests/state/patterns.test.ts`. `npm test` / `npm run typecheck`.
