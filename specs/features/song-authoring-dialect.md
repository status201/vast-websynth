# Song authoring dialect (compact, AI-friendly input format)

```yaml
id: song-authoring-dialect
status: implemented
version: 1
owner: state
related:
  - song-mode
  - ai-prompt
  - ../decisions/adr-013-authoring-dialect-input-only
  - ../decisions/adr-007-songfile-additive-versioning
source:
  - src/state/song-author.ts              # isAuthorSong, expandAuthorSong
  - src/state/song.ts                     # Song.parse routes author files to the expander
  - src/state/authoring-guide.ts          # buildAuthoringGuide / buildSongPrompt (the docs surface)
  - public/schema/websynth-song-author.schema.json  # machine-readable mirror
  - public/llms.txt                       # discovery pointer for crawling agents
```

## Background / Why

Only the strongest LLMs reliably emit a full canonical `SongFile`: the literal
`seqBanks[4][16]` + `drumBanks[4][8][16]` grids are 576+ cells and thousands of
output tokens, so weaker agents truncate mid-JSON or refuse to emit the file at
all. The **authoring dialect** is a compact, *input-only* format
(`format: "websynth-song-author"`) that says the same thing in ~40 lines:
positional note lists, drum hit-lists keyed by track name, chain strings like
`"AABA"`. `Song.parse` expands it into a canonical v3 `SongFile` before
`validateSongFile`, so every ingest surface (Import button, OS file launch,
project-zip `song.json`, share URLs, the MCP server) accepts it automatically.
It is never persisted or exported — see ADR-013.

## Requirements

- **REQ-1** — `isAuthorSong(value)` detects the dialect purely by
  `format === "websynth-song-author"` on a JSON object; `Song.parse` routes such
  values to `expandAuthorSong` and everything else to `validateSongFile`,
  unchanged. Canonical parsing behaviour is untouched.
- **REQ-2** — `expandAuthorSong` validates in **authoring terms first**
  (path-prefixed messages like `seq[0][3]`, capped at 50 errors), expands to a
  canonical v3 `SongFile`, then runs `validateSongFile` as the final gate. The
  result type is the shared `SongValidation`.
- **REQ-3** — Notes are accepted as MIDI numbers (0..127) **or** note names
  matching `^([A-Ga-g])([#b]?)(-?\d+)$` with **C4 = 60**; `null` is a rest
  (`0` is a valid MIDI note, not a rest). Out-of-range/invalid notes are
  authoring errors.
- **REQ-4** — A `seq` bank is either **positional** (array of ≤16 entries, short
  arrays rest-padded; entry = `null` | midi | `"A2"` |
  `{note, velocity?, gate?, prob?, ratchet?, tie?}`) or the **bank-defaults
  form** `{notes: [...], velocity?, gate?, prob?, ratchet?, tie?}` where the
  bank-level settings apply to every ON step (per-entry objects still override).
  On-step defaults: `velocity 0.85, gate 0.5, prob 1, ratchet 1, tie false`;
  off steps expand to `{on: false, note: 60}` + the same defaults. `seq` itself
  is 0..4 banks; missing banks are empty.
- **REQ-5** — A `drums` bank maps **track keys** to hit lists. Keys are
  normalized (lowercase, non-alphanumerics stripped) and matched against
  `kick, snare, chat|hat|hihat|closedhat, ohat|openhat, ltom|lowtom, mtom|midtom,
  htom|hightom, clap` or a numeric `"0".."7"`; an unknown key is an error that
  lists the valid names. A hit is a step index (integer 0..15) or
  `{step, velocity?, gate?, prob?, ratchet?, tie?}`. `sampler` banks are the
  same shape with slot keys `s1..s8` or `"0".."7"`.
- **REQ-6** — A chain (`seqChain`/`drumChain`/`samplerChain`) is a **string** of
  bank letters `A..D` where `.` or `-` is a rest (whitespace ignored), an **int
  array** (−1..3, −1 = rest), or the full `{enabled, steps}` object. String/array
  shorthands imply `enabled: true`; an omitted chain expands to
  `{enabled: false, steps: [0]}`.
- **REQ-7** — Sampler fields (`samplerBanks`/`samplerChain`/`sampleNames`) are
  emitted in the canonical file **only when** the author provided sampler
  content (`sampler`, `samplerChain`, or `sampleNames`). `sampleNames` (≤8
  entries of string|null) is padded to 8 with `null`. `xy` and `params` (sparse
  map of ParamBus id → finite number) pass through; both are optional.
- **REQ-8** — Canonical grid keys (`seqBanks`, `drumBanks`, `samplerBanks`) in
  an author file are **rejected with a pointed error** telling the agent to use
  `format: "websynth-song"` for full-form files — form-mixing is the likeliest
  LLM failure. Other unknown top-level keys are errors listing the allowed keys
  (`$schema` is tolerated).
- **REQ-9** — The dialect is input-only: no code path serializes it. Exports,
  save slots, demos, and project zips remain canonical (ADR-013).
- **REQ-10** — `src/state/song-author.ts` is pure and imports only
  `patterns.ts` + `song-validate.ts` (+ *type-only* `song.ts`), so the MCP
  server's Node bundle can include it without dragging in `import.meta.glob`
  demo registration from `song.ts`.

## Technical design

### Contract / public interface

```ts
// src/state/song-author.ts
export const AUTHOR_FORMAT = 'websynth-song-author';
export function isAuthorSong(value: unknown): boolean;
export function expandAuthorSong(value: unknown): SongValidation; // author-term errors OR {ok:true, file: canonical v3}
```

Hook (the only integration point): `Song.parse` —
`if (isAuthorSong(parsed)) return expandAuthorSong(parsed);` before
`validateSongFile(parsed)`.

### Data shapes

```yaml
AuthorSong:
  format: '"websynth-song-author"'   # required literal
  version: 1                          # required literal
  name: string                        # required
  params: 'Record<paramId, number>'   # optional, sparse
  seq: 'AuthorSeqBank[] (0..4)'       # optional
  drums: 'AuthorHitBank[] (0..4)'     # optional; track-name keys
  sampler: 'AuthorHitBank[] (0..4)'   # optional; slot keys s1..s8 / "0".."7"
  seqChain: 'string | int[] | {enabled, steps}'   # optional; default {enabled:false, steps:[0]}
  drumChain: 'same'
  samplerChain: 'same'
  sampleNames: '(string|null)[] ≤8'   # optional, padded to 8
  xy: '{x: paramId, y: paramId}'      # optional passthrough
AuthorSeqBank: 'entry[] (≤16, rest-padded) | {notes: entry[], velocity?, gate?, prob?, ratchet?, tie?}'
entry: 'null | midi 0..127 | "A2"-style name | {note, velocity?, gate?, prob?, ratchet?, tie?}'
AuthorHitBank: '{ <trackKey>: (step | {step, velocity?, gate?, prob?, ratchet?, tie?})[] }'
```

Expansion targets: full 4×16 `seqBanks` / 4×8×16 `drumBanks` (and 4×8×16
`samplerBanks` when present) built from `TRIGGER_CELL_DEFAULTS` with hits
flipped on — the `drumFrom` idiom, written via `bank[t]?.[s]` for
`noUncheckedIndexedAccess`.

### Layer touchpoints & ordering

- `song-author.ts` (pure) ← imports `patterns.ts` constants/defaults +
  `validateSongFile`; type-only `SongFile`/`ChainData` from `song.ts`.
- `song.ts` → `Song.parse` branches on `isAuthorSong` (REQ-1). Every consumer of
  `Song.parse`/`parseFile`/`fromJSON` (song-panel import, `parseSongOrProject`
  in `project.ts`, launchQueue, song links, MCP tools) inherits the dialect.
- The published author schema and the prompt/guide are documentation mirrors —
  the expander is the runtime source of truth (same relationship as
  `websynth-song.schema.json` ↔ `validateSongFile`).

### Persistence

None. The dialect exists only between `JSON.parse` and `expandAuthorSong`;
nothing writes it (REQ-9/ADR-013).

## Scenarios (BDD)

```gherkin
Scenario: A minimal author file expands to a playable canonical song
  Given {format:"websynth-song-author", version:1, name:"X", seq:[["A2",null,"C3"]], drums:[{kick:[0,4,8,12]}]}
  When Song.parse receives its JSON text
  Then the result is ok with a canonical v3 SongFile
  And seqBanks is 4×16 with step 0 on at note 45
  And drumBanks[0][0] has steps 0/4/8/12 on
  And the file passes validateSongFile

Scenario: Note names map with C4 = 60
  Given entries "C4", "C#4", "Db4", "A0", "G9", 0, null
  When the seq bank expands
  Then they yield ON steps at notes 60, 61, 61, 21, 127, 0 — and one rest
  And "H4" or note 128 is an authoring error

Scenario: Chain shorthands
  Given seqChain "A A B A" and drumChain [0,-1,1]
  When the file expands
  Then seqChain is {enabled:true, steps:[0,0,1,0]}
  And drumChain is {enabled:true, steps:[0,-1,1]}
  And an omitted samplerChain stays {enabled:false, steps:[0]} (absent without sampler content)

Scenario: Canonical keys are rejected with a pointed error
  Given an author file that also carries "seqBanks"
  When expandAuthorSong runs
  Then the errors mention using format "websynth-song" for full-form files

Scenario: Unknown drum track key
  Given drums:[{cowbell:[0]}]
  When expandAuthorSong runs
  Then the error lists the valid track names

Scenario: Expanded output always passes the canonical validator
  Given any author file that expandAuthorSong accepts
  Then validateSongFile(file) is ok
# pinned by: tests/state/song-author.test.ts, tests/state/song.test.ts, tests/state/project.test.ts
```

## Tests & verification

- Unit: `tests/state/song-author.test.ts` (expansion semantics, every error
  path, canonical-validator property), `tests/state/song.test.ts` (parse
  routing + canonical regression), `tests/state/project.test.ts` (author
  `song.json` inside a project zip) — `npm test`
- Typecheck: `npm run typecheck`
- Manual: paste the ✨ AI Prompt into a weaker LLM, import the returned compact
  JSON via Song → Import.

## Open questions / future

- Bar-multiplying shorthands (e.g. `"kick": "x...x...x...x..."` step strings).
- A `swing`/`humanize` authoring hint once the engine grows one.
