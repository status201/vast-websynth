# Preset authoring (guide, validation & expansion)

```yaml
id: preset-authoring
status: implemented
version: 3   # v3: REQ-8 — the semantic layer's severity is the caller's choice,
             #     so the app can run those checks without refusing the file
             # v2: REQ-6 — the schemas point at the published /params.* reference
owner: tooling
related:
  - presets
  - mcp-server
  - param-catalogue
  - ai-prompt
  - song-authoring-dialect
  - paste-import
  - ../decisions/adr-003-no-runtime-dependencies
source:
  - src/state/preset-validate.ts                       # format + two-layer validator + expansion
  - src/state/authoring-guide.ts                       # paramTable + buildPresetGuide
  - src/state/preset-file.ts                           # parsePresetPayload delegates here
  - src/state/preset-session.ts                        # isPatchParam — what counts as a sound
  - public/schema/websynth-preset.schema.json
  - public/schema/websynth-preset-bank.schema.json
  - scripts/mcp/tools.mjs                              # get/validate/expand/save_preset
  - public/llms.txt
```

The **sound** half of machine authoring: a guide an agent can read, a validator
it can iterate against, and the sparse→complete expansion that makes an authored
patch deterministic. The song half is
[song-authoring-dialect](song-authoring-dialect.md); the tools that serve both
are [mcp-server](mcp-server.md).

## Background / Why

[presets](presets.md) gave sounds a portable file, but nothing an AI agent could
author *against*. Three things were missing, and each is a different kind of gap:

1. **No guide.** The ✨ AI Prompt teaches the song format; there was nothing
   equivalent for a patch — no file shape, no statement that a preset is a sound
   and not a song, no map from "make me an acid bass" to `filter.resonance` and a
   short `env.fil.decay`.
2. **No real validation.** `parsePresetPayload` checks "is this a map of finite
   numbers", which is the right bar for *loading a file* but far too low for
   *authoring one*: `"osc1.shape"` (invented) and `"filter.cutoff": 999`
   (out of range, silently clamped by `ParamBus.set`) both passed, so an agent
   got a green light and the user got a different sound.
3. **No completeness rule.** A preset's params map is sparse. Loading a 10-line
   authored patch leaves every unmentioned parameter wherever the *previous*
   sound left it — the exact non-determinism the factory presets avoid by always
   writing the full sound ([presets](presets.md) REQ-2b). An agent cannot be
   asked to hand-write 60 parameters, so the expansion has to happen for it.

The split between the two validation layers is the load-bearing decision here.
Strictness is what an author needs and what a *loader* must not have: a file
written by a newer build may legitimately carry ids this one has never heard of,
and `ParamBus.restore` already ignores them. So the bus — the source of "what
exists and what range it has" — is an **argument**, and only the authoring path
passes it.

## Requirements

- **REQ-1** — The preset file format (`PRESET_FORMAT`/`BANK_FORMAT`, `PresetFile`,
  `PresetBankFile`, `PresetParse`) and its validator live in the pure
  `src/state/preset-validate.ts`. `preset-file.ts` (build/filenames/`planImport`)
  **re-exports** them, so it remains the one door for preset files and no caller
  changed. Dependencies run one way: `preset-file` → `preset-validate`.
- **REQ-2** — **Structural layer** — `validatePresetPayload(value)` with no bus
  checks shape only: the `format` tag, `params`/`presets` being maps of finite
  numbers (naming the offending key by path, e.g. `presets["lead"]."osc1.level"`),
  a non-empty bank, and the wrong-door sentence for a song file. This layer alone
  decides `ok` for `parsePresetPayload` (JSON-decode + this), so the app's file
  import stays forward-compatible however much REQ-8 adds to its warnings.
- **REQ-3** — **Semantic layer** — `validatePresetPayload(value, bus)`
  additionally reports, by default as **errors** (REQ-8 lets a caller ask for
  warnings): an id absent from the registry, a value outside the def's
  `[min, max]`, and a fractional value on a *choice* parameter
  (one with `labels` — its value is the index, so a fraction lands between two
  settings). It reports, as **warnings** (`ok` stays true): an id for which
  `isPatchParam` is false — legal, since a snapshot captures the whole bus, but
  it means loading the sound also moves the song's tempo or a machine's state.
- **REQ-4** — **Expansion.** `defaultPatchParams(bus)` is every *patch* parameter
  at its registered default; `expandPresetParams(bus, params)` layers the
  authored values over it. Song-level ids are **not** filled in — expanding must
  never invent a tempo — but one the author wrote explicitly is preserved (REQ-3
  already warned about it).
- **REQ-5** — **The guide** — `buildPresetGuide(bus, origin?)` in the pure
  `authoring-guide.ts`: OUTPUT RULES (one JSON object; a preset is a sound;
  `params` is sparse and gets completed on import), a QUICKSTART preset that is
  valid as written, both file shapes, SOUND DESIGN NOTES (cutoff is a MIDI note;
  the envelope shapes that make a pluck vs a pad; mono/glide; unison/drift/sub;
  **every FX has an `.on` flag**; acid/reese/rhodes recipes), and the live PARAMS
  table. Both the song and preset guides render that table through the shared
  `paramTable(bus, filter?)`; the preset guide passes `isPatchParam`, so a sound's
  table lists only a sound's parameters.
- **REQ-6** — Both formats are **published** as draft 2020-12 JSON Schemas under
  `public/schema/` and named in `public/llms.txt`. Like the song schemas they
  describe the *shape* and deliberately do **not** enumerate parameter ids, which
  grow with the synth — they point at the **generated** parameter reference
  instead (`/params.json`, `/params.md` — [param-catalogue](param-catalogue.md)),
  which is the same registry rendered rather than a second copy of it. Drift is
  pinned by `tests/state/authoring-docs.test.ts`.
- **REQ-7** — Four MCP tools (see [mcp-server](mcp-server.md) REQ-5b) serve this:
  `get_preset_format`, `validate_preset`, `expand_preset`, `save_preset`. A failed
  validation is a **successful** call carrying the errors — the same rule the song
  tools follow. Three of the four are also on the **public** endpoint;
  `save_preset` is local-only, because it writes into the *server's* working
  directory and a shared host has no such directory a caller can reach
  ([mcp-server](mcp-server.md) REQ-10).
- **REQ-8** *(v3)* — **The semantic layer's severity is the caller's choice.**
  `validatePresetPayload(value, bus, { semantics })` takes `'error'` (default —
  REQ-3 unchanged, and what the MCP tools get) or `'warning'`. The app's door,
  `parsePresetPayload(text, bus)`, asks for `'warning'`.

  The two callers want opposite things and both are right. An **author** is
  writing the file and wants it refused until it says what they meant. An
  **importer** already has the file and wants it to load: `ParamBus.set` **clamps**
  to `[min, max]` and stores an unknown id inertly, with no def and no listeners
  (`src/state/params.ts`), so an out-of-range or unknown parameter costs the sound
  some fidelity and nothing else. Refusing the whole bank over it would be a
  regression, and forward-compatibility depends on it: a preset written by a
  later build naming a parameter this one lacks must still import.

  This is *added* information, not changed verdicts. The app previously passed no
  bus at all, so none of these checks ran; `ok` was decided by the structural
  layer alone (REQ-2) and still is. No file that imports today starts being
  refused, and none that fails today starts passing — only the warning list grows.
  Warnings are omitted from the `ok: false` branch: nothing is importing, so what
  would have been clamped is moot.

## Technical design

### Contract / public interface

```yaml
# src/state/preset-validate.ts — PURE (no DOM, no localStorage)
PRESET_FORMAT: "websynth-preset"
BANK_FORMAT:   "websynth-preset-bank"
validatePresetPayload(value: unknown, bus?: ParamBus, opts?: PresetValidateOptions): PresetParse
PresetValidateOptions:
  semantics?: "error" | "warning"      # v3, REQ-8 — default "error" (REQ-3)
# internally: one `Sinks` {structural, semantic, songSetting} resolved by the entry
# point and threaded down, so severity is decided exactly once (REQ-8)
defaultPatchParams(bus: ParamBus): Snapshot
expandPresetParams(bus: ParamBus, params: Snapshot): Snapshot

# src/state/authoring-guide.ts
paramTable(bus: ParamBus, filter?: (id: string) => boolean): string
buildPresetGuide(bus: ParamBus, origin?: string): string

# src/state/preset-file.ts  (re-exports the above format symbols)
parsePresetPayload(text: string): PresetParse       # structural only, no bus
```

### Data shapes

```yaml
PresetFile:
  format: "websynth-preset"
  version: 1
  name: string
  params: { <paramId>: number }        # SPARSE when authored; complete when expanded

PresetBankFile:
  format: "websynth-preset-bank"
  version: 1
  name: string
  presets: { <presetName>: { <paramId>: number } }   # >= 1 entry

PresetParse:                            # discriminated on ok
  ok: true,  kind: "preset" | "bank",  name: string,
             presets: {name: Snapshot},  warnings?: string[]
  ok: false, errors: string[]           # capped at 50
```

### Layer touchpoints & ordering

```yaml
app file import:   parsePresetPayload(text, bus) -> validatePresetPayload(
                     value, bus, { semantics: 'warning' })          # v3, REQ-8
paste door:        same (paste-import.md)
MCP tools:         validatePresetPayload(value, bus) -> expandPresetParams(bus,…)
                     # no opts -> semantics 'error', REQ-3 verbatim
                     -> buildPresetFile / buildBankFile -> presetFilename / bankFilename
```

The MCP tools build **one** `ParamBus` + `registerDefaults` per server process
(the registry is read-only here) and share it across all four preset tools and
`get_song_format`.

Ordering that matters: expansion runs **after** validation, never before — an
invented id must be reported against what the author wrote, not silently merged
into a full snapshot.

### Persistence

None of its own. The files it validates are the ones
[presets](presets.md) already defines; `save_preset` writes them, and the app
stores imported sounds under `websynth.preset.*` as before.

## Scenarios (BDD)

```gherkin
Scenario: An invented parameter id is refused with a bus, accepted without one
  Given a preset naming "osc1.shape"
  When it is validated with the live ParamBus
  Then it fails, saying that is not a parameter of this synth
  When the same preset is validated with no bus
  Then it passes, because a newer build may have added it
  And the app's import passes too — it asks for that finding as a warning (REQ-8)
# pinned by: tests/state/preset-validate.test.ts

Scenario: An out-of-range value is named with its range
  Given "filter.resonance": 99
  When it is validated against the bus
  Then the error quotes the parameter's registered min..max
# pinned by: tests/state/preset-validate.test.ts

Scenario: A song setting inside a sound warns instead of failing (edge)
  Given a preset that also sets "transport.bpm"
  When it is validated against the bus
  Then it is ok, with a warning that loading it would change the tempo
# pinned by: tests/state/preset-validate.test.ts, tests/mcp/tools.test.ts

Scenario: The importer is told what the author would be refused for (v3, REQ-8)
  Given a preset naming an unknown id and an out-of-range value
  When it is validated with semantics "warning" — what the app's import asks for
  Then it is ok, and both appear as warnings rather than errors
  And the same payload with the default severity still fails with them as errors
# pinned by: tests/state/preset-validate.test.ts

Scenario: Running the registry checks refuses nothing new (v3, REQ-8, regression)
  Given any payload the app's import accepted with no bus
  When parsePresetPayload is given the bus
  Then ok is unchanged — only the warning list grows
# pinned by: tests/state/preset-file.test.ts

Scenario: A sparse preset expands to a complete, deterministic patch
  Given a preset setting only "filter.cutoff"
  When it is expanded
  Then every other patch parameter is present at its registered default
  And no song-level parameter was invented
# pinned by: tests/state/preset-validate.test.ts, tests/mcp/tools.test.ts

Scenario: The shipped sounds satisfy the contract agents are held to
  When every factory preset is validated against the bus
  Then all pass with no errors and no warnings
# pinned by: tests/state/preset-validate.test.ts

Scenario: The preset guide is a sound's guide, not a song's
  When buildPresetGuide(bus) is generated
  Then its PARAMS table holds "filter.cutoff" but not "transport.bpm"
  And it cites both published preset schema URLs absolutely
# pinned by: tests/mcp/tools.test.ts
```

## Tests & verification

- Unit: `tests/state/preset-validate.test.ts` (both layers, expansion, the
  factory-preset pin), `tests/state/preset-file.test.ts` (the structural
  behaviour it delegates), `tests/state/authoring-docs.test.ts` (schema +
  llms.txt drift), `tests/mcp/tools.test.ts` (the four tools) — `npm test`
- Integration: `tests/mcp/integration.test.ts` drives `validate_preset` over real
  stdio, which also proves the new `song-core-entry` exports survive the Vite lib
  build.
- Typecheck: `npm run typecheck`
- Manual: in Claude Code, `get_preset_format` → author a sparse preset →
  `validate_preset` (try a bogus id) → `save_preset` → import the file from the
  app's Preset ▸ Import, or paste it ([paste-import](paste-import.md)).

## Open questions / future

- A **preset share link** (`#preset=…`), mirroring
  [song-share-link](song-share-link.md).
- An in-app "✨ Sound Prompt" beside the AI Prompt, copying `buildPresetGuide`
  for users without an MCP client.
- Bank files carry no migration path beyond the `version` tag; if `Snapshot`
  stops being a flat `Record<string, number>` this needs
  [ADR-007](../decisions/adr-007-songfile-additive-versioning.md)-style rules.
