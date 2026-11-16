# Song file (the on-disk format)

```yaml
id: song-file
status: implemented
version: 1
owner: core
related:
  - song-mode              # captures and applies it
  - untrusted-input        # REQ-an-imported-file-is-validated-first: the limits live there
  - song-authoring-dialect # the compact input form, expanded into this one
  - project-export         # the zip that carries audio beside it
  - banks
  - motion-sequencer
  - sequencer
  - arrangement
  - xy-pad
  - ../decisions/adr-007-songfile-additive-versioning
  - ../decisions/adr-011-export-precision-and-default-sparse-serialization
  - ../recipes/evolve-the-song-format
source:
  - src/state/song-version.ts                 # SONG_VERSION, KNOWN_SONG_VERSIONS
  - src/state/serialize.ts                    # compactSongForExport (round + default-sparse)
  - src/state/song-validate.ts                # validateSongFile (import validation)
  - public/schema/websynth-song.schema.json   # machine-readable JSON Schema (shipped)
```

## Background / Why

A `SongFile` is saved by users, shipped as demos, pasted by AI agents and carried
in links, so it outlives every build that reads it. This spec owns its shape, the
version ladder, what an import must pass, and the canonical form every writer
emits. [Song mode](song-mode.md) owns capturing and applying it; the checklist for
a version bump is [evolve-the-song-format](../recipes/evolve-the-song-format.md).

## Requirements

- **REQ-song-file-is-a-versioned-union** — `SongFile` is a **versioned union**
  (`version: 1 | … | 9`), and this spec owns the ladder:

  | v | adds (all optional, so every older file still loads) |
  | --- | --- |
  | 2 | sampler fields |
  | 3 | `xy`, the [XY Pad](xy-pad.md) axis assignment |
  | 4 | `motionBanks` / `motionAssigns` / `motionChain` ([motion sequencer](motion-sequencer.md)) |
  | 5 | `motionTracks`, two extra single-param motion lanes |
  | 6 | `seqTracks`, [sequencer](sequencer.md) tracks 2–4 |
  | 7 | `seqTranspose` (REQ-song-file-v7-adds-slot-transpose) |
  | 8 | no field: 4..8 banks per machine, and motion lanes widened from 2 to 2..4 (REQ-song-file-v8-widens-the-bank-count) |
  | 9 | no field: the bank ceiling raised to 16 (REQ-song-file-v9-raises-the-bank-ceiling) |

  `capture()` writes the exported **`SONG_VERSION`**, not a literal; the published
  schema and `llms.txt` are pinned to it by `tests/state/authoring-docs.test.ts`.

- **REQ-legacy-step-cells-still-sound-right** — Legacy step cells (plain `{on,
  velocity}`) must load and **sound unchanged** (gain defaults filled in).

- **REQ-audio-is-never-embedded-in-the-json** — Decoded audio is **never
  embedded in the `.json`**; only sampler filenames persist and the user reloads
  files after import. The [project zip](project-export.md) embeds clips
  *alongside* an unchanged `song.json` — the song format itself stays
  audio-free.

- **REQ-an-imported-file-is-validated-first** — An imported file is
  **validated** before it is applied. Validation is hand-rolled (no runtime
  dependency, per ADR-003) and **mirrors the additive loader contract**: strict
  on types / structure / ranges / dimensions, but lenient on the optional
  per-step fields (so legacy v1 files still pass). A rejection surfaces
  **field-level, path-prefixed** messages, not one generic error. A
  machine-readable JSON Schema (draft 2020-12) ships at
  `/schema/websynth-song.schema.json` as the published contract for external
  tools. Leniency is about **shape, never magnitude**
  ([untrusted-input](untrusted-input.md), ADR-015): `SeqStep.note` is an integer
  `0..127` (matching the dialect, which already enforced it), `chainData.steps`
  is `1..MAX_CHAIN_STEPS`, `params` carries at most `MAX_PARAM_KEYS` keys, and a
  `__proto__` / `constructor` / `prototype` key is refused outright. The song's
  `name` is the one field that is **shortened rather than refused**: at most
  50 characters, at every ingest door and in `Song.capture`
  ([untrusted-input](untrusted-input.md) REQ-names-are-capped).

- **REQ-serialization-is-optimised-at-the-boundary** — Serialization is
  **optimized at the boundary** (`toJSON`), never in live state: numbers round
  to 4 significant figures and cells are written **default-sparse**, producing
  the *canonical compact* form. The output must still `apply()` to
  identical-sounding state (rounding is inaudible; sparse cells re-expand via
  `restore`). See
  [ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md).

- **REQ-song-file-v7-adds-slot-transpose** — v7 adds one optional top-level field, `seqTranspose: number[]`, the
  semitone offset of each `seqChain` slot ([arrangement](arrangement.md)
  REQ-a-seq-slot-carries-a-transpose).

  It is a **sibling of `seqChain`, not a field inside it**: `ChainData` keeps its
  `{enabled, steps}` shape, so every reader is untouched and older files round-trip
  through `compactSongForExport` byte-identically (`npm run check:demos`). It is
  **omitted when every offset is 0**, so a song that does not transpose keeps its
  lower version ([song-authoring-dialect](song-authoring-dialect.md)
  REQ-the-emitted-version-is-the-lowest-that-fits). `apply()` defaults it to
  all-zeros.

- **REQ-song-file-v8-widens-the-bank-count** — v8 adds **no field**; it widens two dimensions:
  - each machine's bank array may be 4..8 long, and that length *is* its bank count
    ([banks](banks.md) REQ-a-machine-owns-its-bank-count, ADR-022). The validator's
    exact-length checks became ranges, so older files pass untouched and a
    four-bank song serializes byte-for-byte as before;
  - a motion bank may carry 2..4 extra single-param lanes instead of 2
    ([motion-sequencer](motion-sequencer.md)
    REQ-the-motion-track-array-length-is-the-count).

  The bump exists for the error message: an older build meets "unsupported song
  version 8" rather than an error that reads like a corrupt file, or (for a third
  motion lane) silently drops what it cannot hold.

  A chain step is validated against the **ceiling** (`0..MAX_BANK_COUNT-1`), not
  against the sibling array's length, so a chain naming a bank the arrays omit is
  a legal file — `apply()` grows that machine to fit it
  ([banks](banks.md) REQ-a-chain-reference-grows-the-machine). Two reasons: JSON
  Schema cannot express "≤ the length of a sibling array", so a stricter validator
  would disagree with the published schema; and growing honours what the author
  wrote instead of silently playing a different bank.

- **REQ-song-file-v9-raises-the-bank-ceiling** — v9 adds **no field**: it raises the bank ceiling from 8 (A–H) to 16
  (A–P) via `MAX_BANK_COUNT`. Older files pass untouched, and the bump exists for
  the same error-message reason as v8's. The authoring dialect stamps 9 only when a machine carries more
  than eight banks or a chain names bank I or later
  ([song-authoring-dialect](song-authoring-dialect.md)
  REQ-the-emitted-version-is-the-lowest-that-fits); `capture()` writes
  `SONG_VERSION` as it always has.

## Technical design

### Data shapes (the persistence schema)

Nested beyond ~3 levels, so as flat YAML:

```yaml
SongFile:
  format: 'websynth-song'            # required discriminator
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  name: string
  params: Record<string, number>     # = ParamBus.snapshot()
  seqBanks:  SeqStep[][]             # 4..16 banks × 16 steps — since v6 this is TRACK 1 only
                                     # the LENGTH is the sequencer's bank count (v8, ADR-022; ceiling 16 since v9)
  drumBanks: DrumCell[][][]          # 4..16 banks × 8 tracks × 16 steps, counted separately
  seqChain:  ChainData
  drumChain: ChainData
  # ---- v2 additions (optional, so v1 files still parse) ----
  samplerBanks?: SamplerStep[][][]   # 4..16 banks × 8 slots × 16 steps
  samplerChain?: ChainData
  sampleNames?: (string | null)[]    # filenames ONLY — audio is not embedded
  # ---- v3 addition (optional, so v1/v2 files still parse) ----
  xy?: { x: string; y: string }      # XY Pad axis assignment (ParamBus ids) — see xy-pad.md
  # ---- v4 additions (optional, so v1-v3 files still parse) ----
  motionBanks?: MotionStep[][]       # 4..16 banks × 16 steps of {on, x, y} anchors — see motion-sequencer.md
  motionAssigns?: (MotionAssign | null)[]  # per-bank axis override; null = inherit xy
                                           # same length as motionBanks — the motion trio resizes as one
  motionChain?: ChainData
  # ---- v5 addition (optional, so v1-v4 files still parse) ----
  motionTracks?: (MotionTrack | null)[][]  # per motion bank × 2..4 extra single-param tracks — see motion-sequencer.md
  # ---- v6 addition (optional, so v1-v5 files still parse) ----
  seqTracks?: (SeqStep[] | null)[][]  # [bank][track], indexed by the REAL track number:
                                      # index 0 is ALWAYS null (track 1 stays in seqBanks) and an
                                      # empty track is null. Omitted entirely when no extra track
                                      # holds a step, so a one-track song stays byte-identical to
                                      # its pre-v6 form — see sequencer.md REQ-song-file-v6-adds-seq-tracks.
  # ---- v7 addition (optional, so v1-v6 files still parse) ----
  seqTranspose?: number[]             # per-seq-chain-slot semitone offset, parallel to seqChain.steps.
                                      # A sidecar array rather than a field on ChainData, so ChainData
                                      # keeps its shape and every v1-v6 file round-trips byte-identically.
                                      # Omitted when every offset is 0 — see arrangement.md REQ-a-seq-slot-carries-a-transpose.

ChainData:
  enabled: boolean
  steps: number[]                    # ordered bank indices, one advance per bar
```

`SeqStep` / `DrumCell` / `SamplerStep` are defined in
[`architecture.md`](../architecture.md) (StepSettings + `on` [+ `note`]).

### Import validation (the field-level contract)

`fromJSON` no longer trusts a 4-key presence check — it parses then runs
`validateSongFile` (`src/state/song-validate.ts`), a pure, dependency-free
validator. The validator's job is to reject corruption **without** rejecting any
file the loader would accept, so it tracks the *additive* loader contract above,
not the strict current shape:

```yaml
strict (reject + name the path):
  root:        object; format === 'websynth-song'; version ∈ KNOWN_SONG_VERSIONS (= 1..SONG_VERSION); name: string
  params:      object of string -> finite number   # keys NOT restricted (forward-compat)
  xy?:         { x: non-empty string, y: non-empty string }   # v3; param-id existence NOT checked
  seqBanks:    SeqStep[4..16][16]                    # bank count is a RANGE since v8; steps exact
  seqTracks?:  (SeqStep[16]|null)[4..16][4]          # if present; index 0 of each bank MUST be null
  drumBanks:   DrumCell[4..16][8][16]
  samplerBanks?: SamplerStep[4..16][8][16]           # if present
  motionTracks?: (MotionTrack|null)[4..16][2..4]     # if present; inner length is the lane depth
  sampleNames?:  (string|null)[8]                   # if present
  chainData:   { enabled: boolean, steps: int[1..MAX_CHAIN_STEPS],
                 each 0..MAX_BANK_COUNT-1 or REST }   # the CEILING, not the sibling
                 # array's length — a chain may name a bank the file omits, and
                 # apply() grows that machine to fit (banks.md REQ-a-chain-reference-grows-the-machine)
  cell fields when present, by type/range:
    velocity/gate/prob: number 0..1 ; ratchet: int 1..4 ; tie: boolean
    micro: int -MICRO_MAX..MICRO_MAX
    SeqStep.note: int 0..127                        # MIDI range (untrusted-input REQ-payload-values-are-bounded)
    SeqStep.bend: int -BEND_MAX..BEND_MAX ; SeqStep.bendShape: 'scoop' | 'fall'
                                                    # seq only (step-settings.md REQ-a-seq-step-carries-a-bend)
  seqTranspose?: number[]                           # v7; each int, |offset| <= MAX_CHAIN_TRANSPOSE
  refused at the three validators that build objects from payload keys —
    validateSeqStep, validateTriggerCell, checkParams — via checkKeys():
    __proto__ / constructor / prototype             # untrusted-input REQ-reserved-keys-are-refused scopes this exactly
lenient (additive — do NOT require):
  per-step velocity/gate/prob/ratchet/tie/micro  # pre-v3 cells omit them; restore defaults them
  SeqStep bend/bendShape                         # seq only; absent = no bend
  required-per-cell: SeqStep -> {on, note}; TriggerCell -> {on}
surface:
  fromJSON(text): SongFile | null              # back-compat: returns null on any failure
  parse(text): SongValidation                  # { ok:false, errors:[ "drumBanks[1][3][7].ratchet must be an integer 1..4", ... ] }
  song-io Import:    shows the first 8 errors via alertDialog (see dialog.md),
                     and hands the WHOLE array to its Copy button   # REQ-a-rejected-import-is-copyable-in-full, v24
                     SongSession.apply wrapped in try/catch (that failure copies too)
```

Four surfaces feed bytes into that one path (`SongPanel.importBytes`): the
**Import** file picker, the installed PWA's `launchQueue`
([pwa-install](pwa-install.md) REQ-manifest-declares-install-extras), share links
([song-share-link](song-share-link.md) REQ-boot-consumes-a-present-hash), and — for JSON that arrives as
text rather than a file, which is how AI agents answer — the **Paste** button
([paste-import](paste-import.md)). None of them re-implements validation or
apply; they only produce bytes.

The published JSON Schema (`public/schema/websynth-song.schema.json`, draft
2020-12) encodes the same rules and **ships to `dist/schema/`** via Vite's
`public/` copy (like `worklets/`), fetchable at `/schema/websynth-song.schema.json`.
It is documentation/tooling only — the runtime validator is the hand-rolled TS
above (no schema interpreter at runtime, per ADR-003). Both are kept honest by the
demo-conformance tests (every demo must pass `validateSongFile`).

### Serialization / on-disk compaction (the canonical form)

`Song.toJSON` runs one pure helper, `compactSongForExport` (`src/state/serialize.ts`),
so every persisted artifact is the *canonical compact* form. Live `ParamBus` /
`PatternStore` state is untouched — optimization happens **only** here
([ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md)).

```yaml
round:   every number -> Number(n.toPrecision(4))   # 4 sig-figs; inaudible, keeps tiny exp values
sparse cells (drop fields equal to the cell's restore default):
  trigger (drum/sampler): keep `on`; drop velocity/gate/prob/ratchet/tie/micro when default
                          -> a dead cell is just { "on": false }
  seq:     keep on/note/velocity/gate ALWAYS; drop prob/ratchet/tie/micro/bend/bendShape when default
           # asymmetry: restore spreads SEQ_EXTRA_DEFAULTS (prob/ratchet/tie/micro/bend/bendShape) only,
           # and apply() does not reset the store first, so velocity/gate must be present
params:  every param except UNSAVED_PARAMS kept (rounded) — not default-omitted (forward-compat:
         a future default change must not silently move old songs). capture() stores
         savedParams(snapshot), so a live-only param such as master.expression or
         master.pitchBend never reaches a file (input-control.md REQ-cc11-is-expression,
         REQ-the-pitch-wheel-is-never-saved)
whitespace: download() -> pretty (2-space indent + trailing \n) — byte-identical to
            clean:demos output, so an export dropped into src/state/demos/ diffs
            cleanly with no later churn; saveSlot()/project-zip/share-link/AI-prompt
            example -> compact (no indent)
round-trip: fromJSON(toJSON(x)) === compactSongForExport(x)   # canonical inverse, NOT raw x
            full fidelity is restored by apply()/restore re-expanding defaults
reuse:   compare-to-default happens AFTER rounding (0.8500001 -> 0.85 -> dropped);
         defaults come from TRIGGER_CELL_DEFAULTS / SEQ_EXTRA_DEFAULTS (patterns.ts)
```

## Scenarios (BDD)

```gherkin
Scenario: Export is the canonical compact form (round + default-sparse)
  Given a song with high-precision params and default-valued step cells
  When toJSON serializes it
  Then numbers are rounded to 4 significant figures, a dead drum cell is { "on": false },
    and a default seq step keeps on/note/velocity/gate but omits prob/ratchet/tie/micro/bend/bendShape
  And fromJSON(toJSON(file)) deep-equals compactSongForExport(file)
  And applying it reproduces the original-sounding state (defaults re-expanded)
  And download() writes it pretty-printed (2-space + trailing newline), matching
    `npm run clean:demos` byte-for-byte so demo drop-ins produce readable git diffs
# pinned by: tests/state/serialize.test.ts, tests/state/song.test.ts,
#            e2e/export-project.spec.ts (download formatting)

Scenario: A v1 file loads with empty sampler state (backward compat)
  Given a SongFile with version 1 and no sampler fields
  When apply() runs
  Then it parses, sampler banks/chain default, and seq/drum play unchanged
# pinned by: tests/state/song.test.ts

Scenario: A v2 file loads with default XY axes (backward compat)
  Given a SongFile without an xy field and an XyPadStore
  When apply(file, …, xyStore) runs
  Then the store holds the default axes { x: filter.cutoff, y: filter.resonance }
# pinned by: tests/state/song.test.ts
# see: xy-pad.md → REQ-only-the-axis-assignment-persists

Scenario: Legacy {on, velocity} cells sound unchanged (edge)
  Given a drum cell with only { on, velocity }
  When patterns.restore loads it
  Then it gains gate:1, prob:1, ratchet:1, tie:false
# pinned by: tests/state/patterns.test.ts

Scenario: A valid legacy v1 file passes validation (backward compat)
  Given a version-1 SongFile whose drum cells are plain { on, velocity }
  When validateSongFile runs
  Then it returns { ok: true } (missing per-step fields are tolerated)
# pinned by: tests/state/song-validate.test.ts

Scenario: A sixteen-bank song round-trips, and seventeen is refused (REQ-song-file-v9-raises-the-bank-ceiling)
  Given the Sequencer is grown to sixteen banks and bank P holds steps
  When the song is captured, serialized and applied again
  Then the file says version 9, seqBanks is sixteen long and P's steps survive
  And a file whose seqBanks is seventeen long is rejected naming "seqBanks"
  And a v8 file with eight banks still loads unchanged
# pinned by: tests/state/song.test.ts, tests/state/song-validate.test.ts

Scenario: An out-of-range field is rejected with its path (validation)
  Given a SongFile with a drum cell ratchet of 5
  When validateSongFile runs
  Then it returns { ok: false } and an error naming "drumBanks[…].ratchet"
# pinned by: tests/state/song-validate.test.ts

Scenario: A non-number param is rejected (validation)
  Given a SongFile whose params has a value that is a string or NaN
  When validateSongFile runs
  Then it returns { ok: false } naming the offending param key
# pinned by: tests/state/song-validate.test.ts

Scenario: Every shipped demo conforms to the validator (schema↔reality)
  Given each built-in and each src/state/demos/*.json drop-in
  When validateSongFile runs on it
  Then it returns { ok: true }
# pinned by: tests/state/song-validate.test.ts
```

## Tests & verification

- `tests/state/song.test.ts` (v1/v2 apply, the bank ceiling),
  `tests/state/serialize.test.ts` (rounding, default-sparse cells, canonical
  round-trip), `tests/state/song-validate.test.ts` (accepts every version and
  every demo, path-prefixed rejections, the schema file well-formed),
  `tests/state/authoring-docs.test.ts` (the schema and `llms.txt` follow
  `SONG_VERSION`).

## Open questions / future

- A future `version: 10` keeps new fields **optional** and extends `apply()`'s
  defaults-fallback the same way (ADR-007), per
  [evolve-the-song-format](../recipes/evolve-the-song-format.md).
