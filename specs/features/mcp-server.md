# MCP server (song authoring & validation over stdio)

```yaml
id: mcp-server
status: implemented
version: 7   # v7: REQ-3 — the self-build runs in a child process (no native module pinned)
             # v6: REQ-13 — validate_song/save_song report REQ-12 warnings
             # v5: REQ-5d — get_params; baseUrl defaults to the published site
             # v4: REQ-5c — save_song/save_preset contain `dir` inside cwd
             # v3: expand_song's description names no song version (it drifted to "v3")
             # v2: preset/bank authoring tools alongside the song ones
owner: tooling
related:
  - song-authoring-dialect
  - preset-authoring
  - param-catalogue
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
  anything Vite would print during the self-build, which cannot reach the
  protocol stream at all: the build child's `stdout` *and* `stderr` are both
  piped into the server's `stderr` (`logLevel: 'silent'` and the process-wide
  `console` redirect remain as belt-and-braces).
- **REQ-2** — `initialize` echoes the client's `protocolVersion` when the
  server knows it, else answers `"2025-06-18"`; capabilities are `{tools: {}}`.
  `notifications/initialized` (and all notifications) get no response; `ping`
  returns `{}`; unknown methods get `-32601`; a malformed line gets `-32700`.
- **REQ-3** — The entry **self-builds** `scripts/mcp/dist/song-core.mjs` when
  the bundle is missing or older than any file under
  `scripts/mcp/song-core-entry.ts`, `src/state/**` or `src/utils/**`. A clean
  checkout therefore needs only `npm install` before registering the server.
  The build runs in a **child process** (`node node_modules/vite/bin/vite.js
  build --config …`), never in the server itself: Vite bundles with rolldown,
  whose native binding the OS locks for the lifetime of the process that loaded
  it. In a server that outlives the client's session, an in-process build pins
  `node_modules` for hours and the user's next `npm ci` fails with `EPERM` on a
  file no tool names. Nothing long-lived here may load a native module. A
  missing `vite` binary fails fast, naming `npm install`.
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
    base URL from `$WEBSYNTH_BASE_URL`, default the published site (REQ-5e).
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
- **REQ-5d** — (v5) One **shared** tool ahead of both halves: `get_params`
  returns `buildParamCatalog(bus)` as JSON ([param-catalogue](param-catalogue.md)
  REQ-8). The two `get_*_format` tools serve *prose* — an agent that wants a
  range to compute against had to parse a comment out of the PARAMS table, and
  `taper`, `curve` and `unit` were not in that text at all. It shares the same
  per-process bus as the rest.
- **REQ-5e** — (v5) `baseUrl` defaults to the **published site**, not
  `http://localhost:5173`. Every schema URL the guides cite is built from it, so
  the old default handed the model dead links unless a dev server happened to be
  running — the one thing a *published* schema must not do.
  `$WEBSYNTH_BASE_URL` still overrides, which is how a local dev server or a
  fork's host is pointed at.
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

- **REQ-13** — (v6) **A song that validates can still be wrong, and the agent is
  told.** `validate_song` returns `{ok, errors[], warnings[]}` and `save_song`
  adds `warnings[]` to its success payload, carrying
  [untrusted-input](untrusted-input.md) REQ-12's unresolvable automation targets.
  This closes the authoring loop's one silent hole: an `xy` or `motionTracks`
  target naming a parameter that does not exist used to come back
  `{ok:true, errors:[]}` and then move nothing at play time, which an agent has
  no way to discover — it cannot hear the result. `expand_song` keeps returning
  the song **text alone** (its output is parsed, so a wrapper object would be a
  breaking change); its description points at `validate_song` for warnings.
  Warnings never set `ok:false` — REQ-12 owns why.

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

`websynth-mcp.mjs` → `ensureCore()` (staleness check + Vite build in a child
process, REQ-3) → dynamic
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

Scenario: A dead automation target comes back as a warning (v6, REQ-13)
  Given a song whose xy.x is "filter.cuttoff" and whose motionTracks names "not.a.param"
  When validate_song runs
  Then ok is true and errors is empty
  And warnings names both ids, so the agent can fix a lane it cannot hear
# pinned by: tests/mcp/tools.test.ts

Scenario: Unknown method
  When the client sends method "resources/list"
  Then the response error code is -32601

Scenario: Self-build keeps stdout protocol-pure
  Given a checkout with no scripts/mcp/dist bundle
  When the server starts and a client completes the handshake
  Then every stdout line parses as a JSON-RPC message

Scenario: A rebuild leaves node_modules replaceable (v7, REQ-3, regression)
  Given a stale scripts/mcp/dist bundle
  When the server starts and rebuilds it
  Then the build ran in a child process that has since exited
  And the long-running server holds no native module under node_modules open
  And `npm ci` can replace node_modules while that server is still connected
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
