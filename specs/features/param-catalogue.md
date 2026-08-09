# Parameter catalogue (published param list + format/version overview)

```yaml
id: param-catalogue
status: implemented
version: 1
owner: tooling
related:
  - preset-authoring
  - song-authoring-dialect
  - mcp-server
  - ai-prompt
  - presets
  - song-mode
  - ../decisions/adr-005-cutoff-as-midi-note
  - ../decisions/adr-006-no-op-param-defaults
source:
  - src/state/param-catalog.ts                         # buildParamCatalog — the structured catalogue
  - src/state/authoring-guide.ts                       # paramTable — the prose renderer it reuses
  - scripts/gen-params.ts                              # generator + drift check
  - scripts/gen-params.config.ts                       # npm run gen:params
  - scripts/check-params.config.ts                     # npm run check:params
  - public/params.json                                 # GENERATED — do not hand-edit
  - public/params.md                                   # GENERATED — do not hand-edit
  - public/llms.txt                                    # links both + the format/version table
  - scripts/mcp/tools.mjs                              # get_params
  - scripts/mcp/song-core-entry.ts                     # re-export for the Node bundle
```

The **discovery** half of machine authoring: what parameters exist, what they range
over, and which file formats are at which version — as files an agent can simply
fetch. The guides that teach *how to write* a sound or a song are
[preset-authoring](preset-authoring.md) and
[song-authoring-dialect](song-authoring-dialect.md); the tools that serve them are
[mcp-server](mcp-server.md).

## Background / Why

The parameter table has always been *generated* — `paramTable(bus, filter?)` walks the
live `ParamBus`, so it cannot drift from `registerDefaults()`. But it only ever reached
the outside world through two doors that both require **running something**: the ✨ AI
Prompt modal ([ai-prompt](ai-prompt.md)) and the MCP server's `get_song_format` /
`get_preset_format`. An agent that can neither open a browser nor spawn an MCP server —
the common case for anything reading the deployed site or a checkout — had no parameter
reference at all. `public/llms.txt` said so out loud: the table is "NOT duplicated here".

That refusal was aimed at *hand-maintained* copies, and rightly: a static list of ids
goes stale the first time a param is added, which is why
`tests/state/authoring-docs.test.ts` fails if a schema or `llms.txt` ever names one.
A **generated, drift-checked** artifact was never the thing being refused, and the repo
already has the pattern for it — `src/state/demos-index.json`, written by
`scripts/clean-demos.ts` and guarded by `npm run check:demos` in `prebuild` and CI.

Two smaller gaps travel with it. `ParamDef` carries `taper`, `curve` and `unit` that
`paramTable()` drops, so no agent has ever seen a parameter's taper — it renders only
`min..max`, `default`, `step` and `labels`. And of the four published formats only
`websynth-song` has a named version constant; nothing anywhere answered "what formats
exist, at what version, and what did each version add".

## Requirements

- **REQ-1** — `buildParamCatalog(bus)` in the new, pure `src/state/param-catalog.ts` is
  the **structured** counterpart to `paramTable()`: one entry per registered id, in
  `bus.ids()` order. It is DOM-free and importable by the MCP Node bundle, so it may
  depend only on `params.ts`, `preset-session.ts` and `song-version.ts` — **never**
  `song.ts`, whose `import.meta.glob` demo registration poisons that bundle
  ([mcp-server](mcp-server.md) REQ-4).
- **REQ-2** — An entry carries every `ParamDef` field that is **data**: `id`, `min`,
  `max`, `default`, and the optional `step`, `taper`, `curve`, `unit`, `labels`.
  Optional fields are **omitted when unset**, never emitted as `null`. `format` is
  excluded — it is a render function, not data. Each entry adds `patch: boolean` from
  `isPatchParam`, the sound-vs-song split [preset-authoring](preset-authoring.md) REQ-3
  already reports on.
- **REQ-3** — The catalogue is **published as two generated files** under `public/`, so
  they ship in `dist/` and are fetchable from the deployed site:
  - `params.json` — `buildParamCatalog()` pretty-printed, for programmatic use.
  - `params.md` — the prose table, rendered by the **existing** `paramTable()` in two
    sections: sound parameters (`isPatchParam`) and song-only parameters (its negation).
    There is exactly one param-line format in the repo, and this is not a second one.
  Both carry a generated-file banner. Neither is hand-edited.
- **REQ-4** — `params.json` carries no **app** version. It is stamped with its own
  `format`/`version` pair and with `songVersion` interpolated from `SONG_VERSION`. A
  release bump must not be able to redden the drift check, and a version literal in a
  model-visible file drifts silently ([mcp-server](mcp-server.md) REQ-5).
- **REQ-5** — `scripts/gen-params.ts` writes both files; with `GEN_PARAMS_CHECK` set it
  writes nothing and **fails naming every drifted file**. The two modes are one entry
  behind two vitest configs — `npm run gen:params` and `npm run check:params` — exactly
  as `clean:demos`/`check:demos` are. `gen:params` runs in `prebuild`; `check:params`
  runs in CI, so a param added without regenerating cannot ship.
- **REQ-6** — `public/llms.txt` **links** `/params.json` and `/params.md` instead of
  sending agents to the app, and gains a format/version table: the four formats, their
  versions, their schema URLs, and what each `websynth-song` version added. It still
  carries **no parameter ids** of its own — the existing drift pin stands.
- **REQ-7** — `README.md` links both preset schemas alongside the two song schemas it
  already linked, and names the published param files.
- **REQ-8** — MCP serves the same catalogue as JSON via `get_params`
  ([mcp-server](mcp-server.md) REQ-5d), so a tool-using agent gets ranges it can compute
  against rather than comment text it must parse.

## Technical design

### Contract / public interface

```yaml
# src/state/param-catalog.ts — PURE (no DOM, no localStorage, no song.ts)
PARAMS_FORMAT: "websynth-params"
PARAMS_VERSION: 1
buildParamCatalog(bus: ParamBus): ParamCatalog

# src/state/authoring-guide.ts — reused, unchanged
paramTable(bus: ParamBus, filter?: (id: string) => boolean): string
```

### Data shapes

```yaml
ParamCatalog:
  format: "websynth-params"
  version: 1                  # this file's own format version
  songVersion: number         # SONG_VERSION — which canonical song format ships
  count: number               # params.length, so a fetch can sanity-check itself
  params: ParamCatalogEntry[] # bus.ids() order

ParamCatalogEntry:
  id: string                  # dotted, e.g. "filter.cutoff"
  min: number
  max: number
  default: number
  patch: boolean              # true = part of a SOUND; false = song-level
  step?: number               # omitted when unset
  taper?: "linear" | "exp" | "power" | "discrete"
  curve?: number
  unit?: string
  labels?: string[]           # discrete value map; the VALUE is the index
```

`filter.cutoff` is a MIDI note number, not Hz (ADR-005) — the catalogue reports its
registered range as-is and adds no unit of its own.

### Layer touchpoints & ordering

```yaml
registerDefaults(bus)  ->  buildParamCatalog(bus)  ->  public/params.json
                       ->  paramTable(bus, filter) ->  public/params.md
                       ->  get_params (MCP)        ->  JSON over stdio
```

`scripts/gen-params.ts` builds its own `ParamBus` + `registerDefaults()` — the same
construction `tests/state/authoring-docs.test.ts` and `makeTools`' lazy bus use. No
engine, no DOM, no audio context is involved: the registry is the only input.

### Persistence

Nothing is persisted. Both files are build artifacts committed to the repo (like
`src/state/demos-index.json`) so that a checkout and the deployed site agree without a
build step. They are *inputs to no code* — the app never reads them.

## Scenarios (BDD)

```gherkin
Scenario: the published catalogue matches the live registry
  Given a ParamBus with registerDefaults() applied
  When public/params.json is parsed
  Then it names every registered id, in bus order, with that id's min/max/default
  And its songVersion equals SONG_VERSION
# pinned by: tests/state/authoring-docs.test.ts

Scenario: a discrete parameter publishes its value map
  Given "osc1.wave" is registered with labels sine/triangle/saw/square
  When the catalogue entry for it is read
  Then labels lists them in index order and taper is "discrete"
# pinned by: tests/state/authoring-docs.test.ts

Scenario: an unset optional field is absent, not null
  Given a parameter registered without a unit
  When its catalogue entry is serialized
  Then the entry has no "unit" key
# pinned by: tests/state/authoring-docs.test.ts

Scenario: the sound/song split matches the preset validator
  Given every entry in the catalogue
  When its patch flag is compared with isPatchParam(id)
  Then they agree for every id
# pinned by: tests/state/authoring-docs.test.ts

Scenario: adding a parameter without regenerating fails the build
  Given a new param registered in registerDefaults()
  When npm run check:params runs
  Then it fails naming public/params.json and public/params.md
# pinned by: scripts/gen-params.ts

Scenario: llms.txt points at the files instead of the app
  Given public/llms.txt
  When an agent reads the parameter section
  Then it links /params.json and /params.md
  And it still carries no parameter ids of its own
# pinned by: tests/state/authoring-docs.test.ts

Scenario: an agent fetches the catalogue over MCP
  Given the MCP server
  When get_params is called
  Then it returns the same catalogue as JSON text
# pinned by: tests/mcp/tools.test.ts
```

## Tests & verification

- Unit: `tests/state/authoring-docs.test.ts` (the existing drift-pin file — the
  catalogue is pinned beside the schemas and `llms.txt`, not in a new file) and
  `tests/mcp/tools.test.ts` — `npm test`
- Drift gate: `npm run check:params` (CI, beside `check:demos`)
- Regenerate: `npm run gen:params` (also runs in `prebuild`)
- Typecheck: `npm run typecheck`

## Open questions / future

- `websynth-song-author`, `websynth-preset` and `websynth-preset-bank` still carry their
  version as a bare literal at each use site; only `SONG_VERSION` is a named constant.
  The format table in `llms.txt` is hand-kept for those three until they get one.
- The JSON Schemas still describe `params` as an open `{string: number}` map
  ([preset-authoring](preset-authoring.md) REQ-6). Now that a machine-readable id list
  exists, a generated `enum` is possible — but it would make every schema reject files
  from a newer build, which is the forward-compatibility the open map buys.
