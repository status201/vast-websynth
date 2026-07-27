# Song authoring dialect (compact, AI-friendly input format)

```yaml
id: song-authoring-dialect
status: implemented
version: 3   # v3: the emitted canonical version is the LOWEST that holds the content
             #     (REQ-12), plus the two dialect forms that were shipped but never
             #     specified — multi-track seq banks (REQ-13) and motionTracks (REQ-14)
owner: state
related:
  - song-mode
  - ai-prompt
  - sequencer          # REQ-13's multi-track banks land in seqTracks (its REQ-13)
  - motion-sequencer   # REQ-14's motionTracks (its REQ-17)
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
`"AABA"`. `Song.parse` expands it into a canonical `SongFile` — at the **lowest
version that can hold what was authored** (REQ-12) — before `validateSongFile`,
so every ingest surface (Import button, OS file launch, project-zip `song.json`,
share URLs, the MCP server) accepts it automatically. It is never persisted or
exported — see ADR-013.

## Requirements

- **REQ-1** — `isAuthorSong(value)` detects the dialect purely by
  `format === "websynth-song-author"` on a JSON object; `Song.parse` routes such
  values to `expandAuthorSong` and everything else to `validateSongFile`,
  unchanged. Canonical parsing behaviour is untouched.
- **REQ-2** — `expandAuthorSong` validates in **authoring terms first**
  (path-prefixed messages like `seq[0][3]`, capped at 50 errors), expands to a
  canonical `SongFile` (at the version REQ-12 selects), then runs
  `validateSongFile` as the final gate. The result type is the shared
  `SongValidation`.
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
  is 0..4 banks; missing banks are empty. A bank may also take the **multi-track
  form** of REQ-13.
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
- **REQ-11** — **Machines with content auto-enable** (v2): `seq.on`, `drum.on`
  and `sampler.on` are ParamBus params that default to **0**, and `Song.apply`
  resets to defaults before restoring a song's params — so an expanded author
  file whose `params` lacks them would import silent despite filled banks
  (the original bug). Expansion therefore sets `params["<machine>.on"] = 1`
  when (a) the author did not set that param explicitly **and** (b) the
  machine's expanded banks contain at least one ON step/cell. An explicit
  author value always wins (e.g. `"seq.on": 0` keeps the sequencer off), and a
  machine with no hits keeps the default. `sampler.on` is considered only when
  sampler content is present (REQ-7).
- **REQ-12** — **The emitted canonical version is the LOWEST that can hold what
  was authored**, never a bare `SONG_VERSION`. The ladder, top rung first:
  **6** when any seq bank uses tracks 2-4 (REQ-13), else **5** when
  `motionTracks` is present (REQ-14), else **4** when motion content is present,
  else **3**. Consequence — and the reason for the rule — an author file that
  uses none of those newer fields keeps expanding to the *same v3 file it always
  did*, so nothing downstream (share links, project zips, golden fixtures) shifts
  when the canonical format grows. Every rung is the version that **introduced**
  its field, per ADR-007's additive contract; a new format version therefore adds
  a rung rather than moving the existing ones.
- **REQ-13** — **A `seq` bank may carry up to `SEQ_TRACK_COUNT` (4) simultaneous
  tracks** as `{tracks: [entryList, entryList, …]}` — chords and counter-lines.
  Each list is a REQ-4 bank in its own right (positional or bank-defaults form).
  The **plain** (non-`tracks`) form is unchanged and lands on **track 1**, so
  every pre-existing dialect song expands byte-identically. A `tracks` key may
  not be combined with the bank-defaults settings keys (put them inside each
  track) and more than 4 tracks is an authoring error. Tracks 2-4 sound only in
  poly voicing ([sequencer](sequencer.md) REQ-8); a bank using them lifts the
  emitted version to 6 (REQ-12), where they land in `seqTracks`.
- **REQ-14** — **`motionTracks` is a top-level author key**: 0..4 banks × 0..2
  (`MOTION_TRACK_COUNT`) extra single-param automation tracks, each
  `{param: "<ParamBus id>", steps: [{step: 0..15, v: 0..1}, …]}` or `null`.
  A track that names no param **and** has no ON anchor expands to `null`, keeping
  the canonical file default-sparse ([motion-sequencer](motion-sequencer.md)
  REQ-17). Over-long bank/track arrays are authoring errors naming the real
  counts. `motionTracks` counts as motion content for REQ-7's presence rule — it
  alone is enough to emit `motionBanks`/`motionAssigns`/`motionChain` — and lifts
  the emitted version to 5 (REQ-12). It also feeds REQ-11's auto-enable: a track
  that names a param **and** carries at least one anchor sets `motion.on = 1`
  exactly as an XY anchor does.

## Technical design

### Contract / public interface

```ts
// src/state/song-author.ts
export const AUTHOR_FORMAT = 'websynth-song-author';
export function isAuthorSong(value: unknown): boolean;
export function expandAuthorSong(value: unknown): SongValidation; // author-term errors OR {ok:true, file: canonical, version per REQ-12}
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
  motion: 'AuthorMotionBank[] (0..4)' # optional; XY param automation (motion-sequencer.md)
  motionTracks: 'AuthorMotionTrackBank[] (0..4)'  # optional; the 2 extra 1-param tracks per bank (REQ-14)
  seqChain: 'string | int[] | {enabled, steps}'   # optional; default {enabled:false, steps:[0]}
  drumChain: 'same'
  samplerChain: 'same'
  motionChain: 'same'
  sampleNames: '(string|null)[] ≤8'   # optional, padded to 8
  xy: '{x: paramId, y: paramId}'      # optional passthrough
AuthorSeqBank: 'entry[] (≤16, rest-padded) | {notes: entry[], velocity?, gate?, prob?, ratchet?, tie?} | {tracks: AuthorSeqBank[] (≤4)}'
entry: 'null | midi 0..127 | "A2"-style name | {note, velocity?, gate?, prob?, ratchet?, tie?}'
AuthorHitBank: '{ <trackKey>: (step | {step, velocity?, gate?, prob?, ratchet?, tie?})[] }'
AuthorMotionBank: 'anchor[] | {assign?: {x?: paramId, y?: paramId}, steps: anchor[]}'
anchor: '{step: 0..15, x: 0..1, y: 0..1}'   # normalized taper-space coordinates
AuthorMotionTrackBank: '(AuthorMotionTrack | null)[] (≤2)'
AuthorMotionTrack: '{param: paramId, steps: [{step: 0..15, v: 0..1}, …]} | null'
```

The emitted canonical version (REQ-12):

```yaml
seq bank uses tracks 2-4  -> 6   # seqTracks      (sequencer.md REQ-13)
motionTracks present      -> 5   # motionTracks   (motion-sequencer.md REQ-17)
motion content present    -> 4   # motionBanks/motionAssigns/motionChain
otherwise                 -> 3   # the long-standing baseline — unchanged forever
```

Expansion targets: full 4×16 `seqBanks` / 4×8×16 `drumBanks` (and 4×8×16
`samplerBanks` when present) built from `TRIGGER_CELL_DEFAULTS` with hits
flipped on — the `drumFrom` idiom, written via `bank[t]?.[s]` for
`noUncheckedIndexedAccess`. Motion content mirrors the sampler presence rule:
`motionBanks` (4×16 from `MOTION_STEP_DEFAULTS`) + `motionAssigns` +
`motionChain` are emitted only when the author provided
`motion`/`motionChain`/`motionTracks`, `motion.on` auto-enables when anchors
exist (never overriding an explicit author value), and `motionBanks` joins the
canonical-key form-mixing guard.

Seq expansion is internally always 4 tracks (`expandSeqBankTracks` returns
`SeqStep[SEQ_TRACK_COUNT][16]` whichever author form was used); the *emit* step
splits them the way the canonical format wants — track 1 into `seqBanks`, and
`seqTracks` added **only when a track 2-4 actually carries an ON step**, with
index 0 always `null` (sequencer.md REQ-13). That split, not the author form, is
what decides REQ-12's top rung: `{tracks: [notes]}` with a single list is still a
v3 file.

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
  Then the result is ok with a canonical v3 SongFile (REQ-12's baseline rung)
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

Scenario: Machines with hits play after import (regression — REQ-11)
  Given an author file with seq notes and drum hits and NO params
  When it expands and Song.apply loads the result
  Then params carry seq.on = 1 and drum.on = 1 (the machines actually play)
  And sampler.on appears only when the file has sampler content with hits

Scenario: An explicit machine on/off param is respected (edge — REQ-11)
  Given an author file with drum hits and params {"drum.on": 0}
  When it expands
  Then params.drum.on stays 0 (auto-enable never overrides the author)

Scenario: Motion anchors expand to v4 with per-bank assign
  Given motion:[[{step:0,x:0.5,y:0}], {assign:{x:"fx.delay.time"}, steps:[{step:4,x:1,y:1}]}]
  When the file expands
  Then the result is a version 4 SongFile with motionBanks anchors on and
       motionAssigns [null-for-A, {x:"fx.delay.time"}], and motion.on = 1
# pinned by: tests/state/song-author.test.ts (motion dialect describe)
  And a machine whose banks have no ON steps gets no param injected

Scenario: The emitted version is the lowest that holds the content (REQ-12)
  Given four author files — plain seq+drums; + motion; + motionTracks; + seq tracks 2-4
  When each expands
  Then their canonical versions are 3, 4, 5 and 6 respectively
  And each one passes validateSongFile
# pinned by: tests/state/song-author.test.ts (one version assertion per describe:
#            happy path, motion dialect, extra motion tracks, four sequencer tracks)

Scenario: A seq bank plays four simultaneous tracks (REQ-13)
  Given seq:[{tracks: [["C3"], ["E3"], ["G3"]]}]
  When the file expands
  Then seqBanks[0] carries track 1 ("C3") exactly as the plain form would
  And seqTracks[0] is [null, <E3 track>, <G3 track>, null] — index 0 always null
  And the emitted version is 6

Scenario: A one-track "tracks" bank stays a v3 file (edge — REQ-12/REQ-13)
  Given seq:[{tracks: [["C3", null, "E3"]]}]
  When the file expands
  Then seqTracks is absent and the version is 3 — the author form does not
       decide the version, the presence of ON steps on tracks 2-4 does

Scenario: tracks cannot be combined with bank-level settings (edge — REQ-13)
  Given seq:[{tracks: [["C3"]], gate: 0.9}]
  When expandAuthorSong runs
  Then the error says gate cannot be combined with tracks (put it inside each track)
  And more than 4 tracks is likewise an error naming the real track count
# pinned by: tests/state/song-author.test.ts (four sequencer tracks describe)

Scenario: motionTracks automate two more params per bank (REQ-14)
  Given motionTracks:[[{param:"filter.cutoff", steps:[{step:0,v:0},{step:8,v:1}]}, null]]
  When the file expands
  Then the result is a version 5 SongFile whose motionTracks[0][0] carries those
       anchors and whose motionTracks[0][1] is null
  And motionBanks/motionAssigns/motionChain are emitted even though "motion" was absent
  And motion.on = 1

Scenario: An unassigned, anchorless motion track expands to null (edge — REQ-14)
  Given motionTracks:[[{steps: []}, null]]
  When the file expands
  Then motionTracks[0] is [null, null] — the canonical file stays default-sparse
# pinned by: tests/state/song-author.test.ts (extra motion tracks describe)

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
