# MCP server (song authoring & validation over stdio)

```yaml
id: mcp-server
status: implemented
version: 4   # v4: REQ-5c — save_song/save_preset contain `dir` inside cwd
             # v3: expand_song's description names no song version (it drifted to "v3")
             # v2: preset/bank authoring tools alongside the song ones
owner: tooling
related:
  - song-authoring-dialect
  - preset-authoring
  - song-share-link
  - ai-prompt
  - untrusted-input
  - ../decisions/adr-003-no-runtime-dependencies
  - ../decisions/adr-013-authoring-dialect-input-only
source:
  - scripts/mcp/websynth-mcp.mjs      # entry: stdio framing + self-build of the core bundle
  - scripts/mcp/rpc.mjs               # pure JSON-RPC 2.0 / MCP dispatch
  - scripts/mcp/tools.mjs             # makeTools(core) — the song + preset tools
  - scripts/mcp/song-core-entry.ts    # the pure song core the lib bundle re-exports
  - scripts/mcp/vite.lib.config.ts    # ES lib build → scripts/mcp/dist/song-core.mjs
  - .mcp.json                         # repo-root registration for Claude Code
```

## Background / Why

AI agents that can call tools do far better with a **feedback loop** than with
one-shot generation: fetch the format, emit a song, validate it, fix the
errors, save the file. The MCP server exposes exactly that loop over the
Model Context Protocol — v2 exposes it for **sounds** as well as songs
([preset-authoring](preset-authoring.md)), because a preset is the other half
of what this synth stores and it was the half an agent could not write. It is **hand-rolled and zero-dependency** (ADR-003):
plain JSON-RPC 2.0 over stdio with newline-delimited framing, no SDK. The app's
song core (`src/**`) can't run under plain Node (extensionless TS imports), so
the server builds a small **Vite lib bundle** of the *pure* song subtree on
first run and imports that.

## Requirements

- **REQ-1** — Transport is **stdio** with newline-delimited JSON-RPC 2.0
  messages (one JSON object per line), per the MCP spec. `stdout` carries
  **protocol frames only**; every log/diagnostic goes to `stderr` — including
  anything Vite would print during the self-build (console redirected +
  `logLevel: 'silent'`).
- **REQ-2** — `initialize` echoes the client's `protocolVersion` when the
  server knows it, else answers `"2025-06-18"`; capabilities are `{tools: {}}`.
  `notifications/initialized` (and all notifications) get no response; `ping`
  returns `{}`; unknown methods get `-32601`; a malformed line gets `-32700`.
- **REQ-3** — The entry **self-builds** `scripts/mcp/dist/song-core.mjs` (via
  the Vite JS API, `build({configFile})`) when the bundle is missing or older
  than any file under `scripts/mcp/song-core-entry.ts`, `src/state/**` or
  `src/utils/**`. A clean checkout therefore needs only `npm install` before
  registering the server.
- **REQ-4** — `song-core-entry.ts` re-exports only the **pure** core:
  `validateSongFile`, `isAuthorSong`/`expandAuthorSong`,
  `compactSongForExport`, `buildAuthoringGuide`, `ParamBus`/`registerDefaults`,
  plus (v2) the preset half — `validatePresetPayload`, `expandPresetParams`,
  `defaultPatchParams`, `buildPresetGuide`, `buildPresetFile`/`buildBankFile`,
  `presetFilename`/`bankFilename`. It must never (transitively) import
  `src/state/song.ts` — its `import.meta.glob` demo registration doesn't bundle
  for Node. `src/state/preset.ts` is likewise never pulled in (it opens
  `localStorage`); only its `Snapshot` **type** is used, which erases.
- **REQ-5** — Five song tools, all built by `makeTools(core)` with the core
  **injected** (unit-testable without the bundle):
  - `get_song_format` — the live authoring guide
    (`new ParamBus()` + `registerDefaults` + `buildAuthoringGuide(bus, baseUrl)`).
  - `validate_song` — `{ok, errors[]}` for either format. A validation failure
    is a **successful** call (`isError: false`) so the model reads the errors
    and fixes the song rather than treating the call as crashed.
  - `expand_song` — author dialect → canonical compact JSON, at the lowest
    version that holds the content (song-authoring-dialect.md REQ-12). The tool
    **description names no version** — a literal there is model-visible and drifts
    on every format bump, which it did (it advertised "v3" through v4, v5 and v6).
  - `save_song` — validate (either format), write
    `<safe-name>.websynth.json` (canonical compact), return the absolute path.
  - `make_share_link` — canonical compact JSON → `node:zlib.deflateRawSync` →
    base64url → `<base>/#song=…` (the wire format of song-share-link.md);
    base URL from `$WEBSYNTH_BASE_URL`, default `http://localhost:5173`.
- **REQ-5b** — (v2) Four **preset** tools, same shape and same "a failed
  validation is a successful call" rule (see
  [preset-authoring](preset-authoring.md)), listed after the song five:
  - `get_preset_format` — `buildPresetGuide(bus, baseUrl)`.
  - `validate_preset` — `{ok, kind, name, presets[], errors[], warnings[]}`
    against the live registry (invented ids and out-of-range values are errors).
  - `expand_preset` — sparse → the **complete** preset/bank file the app exports.
  - `save_preset` — validate + expand + write `<name>.preset.websynth.json` or
    `<name>.bank.websynth.json` (chosen by the payload's own format), returning
    the absolute path. `dir` defaults to the server working directory, like
    `save_song`.
  All preset tools and `get_song_format` share **one** `ParamBus` +
  `registerDefaults` per process — the registry is read-only here.
- **REQ-5c** — (v4) **A write stays inside the working directory.** Both
  `save_song` and `save_preset` sanitize the *filename* (`safeName`) **and**
  contain the `dir` argument: `resolve(cwd, dir)` must remain under `cwd` or the
  call fails without writing (`isAbsolute(relative(cwd, target))` is what catches
  another Windows drive letter, where `relative` returns an absolute path rather
  than `..`). `dir` is already documented as "the server working directory", so
  containment is the contract — it just wasn't enforced, and
  `mkdirSync(…, {recursive:true})` would happily create the path on the way out.
  The caller is a model, and a model summarising a hostile song file is a
  prompt-injection route to an arbitrary file write
  ([untrusted-input](untrusted-input.md) REQ-11).
- **REQ-6** — Tool *input* errors (unknown tool, missing argument) are JSON-RPC
  errors; tool *runtime* failures return `isError: true` with the message in
  `content` (per MCP). Unparseable `song` JSON strings count as validation
  results (`{ok:false, errors:[…]}`), not crashes.
- **REQ-7** — `.mcp.json` at the repo root registers the server for Claude
  Code (`node scripts/mcp/websynth-mcp.mjs`); the README documents wiring for
  other MCP clients. `scripts/mcp/dist/` is gitignored.

## Technical design

### Contract / public interface

```yaml
rpc.mjs:
  createDispatcher: '({name, version, tools}) => async (msg) => response | null'
  # tools: [{name, description, inputSchema, handler(args) => Promise<{content, isError?}>}]
tools.mjs:
  makeTools: '(core, {baseUrl?, cwd?}?) => Tool[]'
song-core-entry.ts: 're-exports the pure core (REQ-4)'
websynth-mcp.mjs: 'stdio loop: readline → JSON.parse → dispatch → stdout line'
```

### Layer touchpoints & ordering

`websynth-mcp.mjs` → `ensureCore()` (staleness check + Vite build) → dynamic
`import(dist/song-core.mjs)` → `makeTools(core)` → `createDispatcher` →
readline loop. `rpc.mjs`/`tools.mjs` never touch stdio themselves, so they
stay pure for unit tests.

### Persistence

`scripts/mcp/dist/song-core.mjs` (gitignored build artifact) and the
`save_song` output file. Nothing else.

## Scenarios (BDD)

```gherkin
Scenario: Initialize handshake
  Given the server is running over stdio
  When the client sends initialize with protocolVersion "2025-06-18"
  Then the response echoes "2025-06-18", capabilities {tools:{}}, and serverInfo

Scenario: Validation failure is a successful tools/call
  When tools/call validate_song receives a song with a bad note
  Then the response has isError absent/false
  And its text payload is {"ok":false,"errors":[…]} naming the bad field

Scenario: expand_song returns canonical compact JSON
  When tools/call expand_song receives a valid author-dialect song
  Then the text payload parses as format "websynth-song", version 3
       (that song uses no post-v3 field — see song-authoring-dialect.md REQ-12;
        this is the expansion's floor, not the canonical version)
  And it passes validate_song

Scenario: A preset with an invented parameter id fails validation (v2)
  When tools/call validate_preset receives params naming "osc1.shape"
  Then isError is absent/false
  And the payload is {"ok":false,"errors":[…]} naming that id
# pinned by: tests/mcp/tools.test.ts, tests/mcp/integration.test.ts

Scenario: save_preset picks the extension from the payload (v2)
  When tools/call save_preset receives a websynth-preset-bank payload
  Then the written path ends in .bank.websynth.json
  And its params are expanded to the complete patch

Scenario: A save cannot escape the working directory (v4)
  Given save_song (or save_preset) called with dir '../..' or an absolute path
  Then the call fails and no file or directory is created
  And dir 'sub/dir' still writes normally
# pinned by: tests/mcp/tools.test.ts

Scenario: Unknown method
  When the client sends method "resources/list"
  Then the response error code is -32601

Scenario: Self-build keeps stdout protocol-pure
  Given a checkout with no scripts/mcp/dist bundle
  When the server starts and a client completes the handshake
  Then every stdout line parses as a JSON-RPC message
# pinned by: tests/mcp/rpc.test.ts, tests/mcp/tools.test.ts, tests/mcp/integration.test.ts
```

## Tests & verification

- Unit: `tests/mcp/rpc.test.ts` (dispatch), `tests/mcp/tools.test.ts` (tools
  against the real src core, imported directly under Vitest — no bundle
  needed) — `npm test`
- Integration: `tests/mcp/integration.test.ts` — builds the core bundle, spawns
  the server, drives initialize → tools/list → validate_song over real stdio.
- Manual: in Claude Code (this repo's `.mcp.json`) run `get_song_format`, feed
  a broken author file to `validate_song`, then `save_song` and import the
  written file in the app. Same round for `get_preset_format` →
  `validate_preset` (try a bogus id) → `save_preset` → Preset ▸ Import.

## Open questions / future

- npm-publishable standalone package (`npx websynth-mcp`).
- A `render_song` tool once an offline render path exists outside the browser.
