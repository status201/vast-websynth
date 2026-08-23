# MCP server (song authoring & validation, local stdio + public HTTP)

```yaml
id: mcp-server
status: implemented
version: 8   # v8: REQ-1/9/10/11 — a second transport (Streamable HTTP) and the
             #     read-only remote profile behind https://vast.status201.com/mcp
             # v7: REQ-3 — the self-build runs in a child process (no native module pinned)
             # v6: REQ-8 — validate_song/save_song report untrusted-input REQ-12's warnings
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
  - pwa-install
  - ../decisions/adr-003-no-runtime-dependencies
  - ../decisions/adr-013-authoring-dialect-input-only
  - ../decisions/adr-015-untrusted-input-is-bounded
  - ../decisions/adr-020-remote-mcp-is-authless-and-read-only
source:
  - scripts/mcp/websynth-mcp.mjs      # local entry: stdio framing (REQ-1a)
  - scripts/mcp/websynth-mcp-http.mjs # local entry: HTTP, self-building (REQ-1b)
  - scripts/mcp/app.js                # deployed entry: HTTP, prebuilt bundle only (REQ-9e)
  - scripts/mcp/core.mjs              # shared: staleness check + child-process self-build
  - scripts/mcp/http.mjs              # Streamable HTTP transport + bounds (REQ-9/11)
  - scripts/mcp/rpc.mjs               # pure JSON-RPC 2.0 / MCP dispatch (both transports)
  - scripts/mcp/tools.mjs             # makeTools(core) — the song + preset tools
  - scripts/mcp/song-core-entry.ts    # the pure song core the lib bundle re-exports
  - scripts/mcp/vite.lib.config.ts    # ES lib build → scripts/mcp/dist/song-core.mjs
  - src/state/limits.ts               # MAX_MCP_* — the bounds, per untrusted-input REQ-3
  - .mcp.json                         # repo-root registration for Claude Code
```

`scripts/mcp/**` and `.mcp.json` are **not** SDD-gated paths — `sdd-guard.mjs`
watches `src/**` and `public/worklets/**` — but this spec is their source of
truth anyway: treat a change to any of them as a change to this spec. That
matters more here than the exemption suggests, because `http.mjs` is the trust
boundary of a public endpoint (REQ-11) and nothing automated will stop an edit
to it landing without one.

## Background / Why

AI agents that can call tools do far better with a **feedback loop** than with
one-shot generation: fetch the format, emit a song, validate it, fix the
errors, save the file. The MCP server exposes exactly that loop over the
Model Context Protocol — v2 exposes it for **sounds** as well as songs
([preset-authoring](preset-authoring.md)), because a preset is the other half
of what this synth stores and it was the half an agent could not write. It is **hand-rolled and zero-dependency** (ADR-003):
plain JSON-RPC 2.0, no SDK. The app's
song core (`src/**`) can't run under plain Node (extensionless TS imports), so
the server builds a small **Vite lib bundle** of the *pure* song subtree on
first run and imports that.

**v8 publishes it.** Everything above was reachable only by someone who had
cloned the repo and run `npm install` — which is backwards for tools that serve
the *published* guides, the *published* parameter catalogue and validators for a
*published* document format. There is now a second transport (Streamable HTTP)
behind `https://vast.status201.com/mcp`, addable with
`claude mcp add --transport http websynth https://vast.status201.com/mcp` or as a
Claude.ai custom connector. It is **authless and read-only**, and
[ADR-020](../decisions/adr-020-remote-mcp-is-authless-and-read-only.md) owns why
those two go together. `createDispatcher` was already transport-agnostic, so the
protocol half was reused unchanged; what is new is framing, bounds and the
question of which tools a stranger may call.

## Requirements

- **REQ-1** — (v8) **Two transports, one dispatcher.** `createDispatcher`
  (`rpc.mjs`) maps a parsed JSON-RPC message to a response object and knows
  nothing about framing; both transports are thin shells around it, and REQ-2's
  protocol behaviour is therefore identical on each. A transport chooses only
  two things: how a message arrives, and which tool profile it serves (REQ-10).

- **REQ-1a** — **stdio** (local): newline-delimited JSON-RPC 2.0, one JSON
  object per line, per the MCP spec. `stdout` carries **protocol frames only**;
  every log/diagnostic goes to `stderr` — including anything Vite would print
  during the self-build, which cannot reach the protocol stream at all: the build
  child's `stdout` *and* `stderr` are both piped into the server's `stderr`
  (`logLevel: 'silent'` and the process-wide `console` redirect remain as
  belt-and-braces). This is the profile `.mcp.json` registers (REQ-7) and it
  keeps **all ten** tools.

- **REQ-1b** — **Streamable HTTP** (remote): one JSON-RPC message per `POST`,
  one JSON response per request, no SSE and no session (REQ-9). Logs go to
  `stdout`/`stderr` freely — there is no protocol stream to poison, which is the
  one rule that does *not* carry over from REQ-1a. It serves the read-only
  **eight**-tool profile (REQ-10) and is bounded by REQ-11.

- **REQ-2** — `initialize` echoes the client's `protocolVersion` when the
  server knows it, else answers `"2025-06-18"`; capabilities are `{tools: {}}`.
  `notifications/initialized` (and all notifications) get no response; `ping`
  returns `{}`; unknown methods get `-32601`; a malformed line gets `-32700`.

- **REQ-3** — The **local** entries self-build `scripts/mcp/dist/song-core.mjs`
  when the bundle is missing or older than any file under
  `scripts/mcp/song-core-entry.ts`, `src/state/**` or `src/utils/**`. A clean
  checkout therefore needs only `npm install` before registering the server.
  The build runs in a **child process** (`node node_modules/vite/bin/vite.js
  build --config …`), never in the server itself: Vite bundles with rolldown,
  whose native binding the OS locks for the lifetime of the process that loaded
  it. In a server that outlives the client's session, an in-process build pins
  `node_modules` for hours and the user's next `npm ci` fails with `EPERM` on a
  file no tool names. Nothing long-lived here may load a native module. A
  missing `vite` binary fails fast, naming `npm install`.
  (v8) The check and the build live in `core.mjs` as
  `loadCore({selfBuild})`, shared by both local entries. **The deployed entry
  passes `selfBuild: false`** and *throws* on a missing bundle instead of
  building one: production has no `node_modules` to build from, and a server
  that shells out to a bundler on an unauthenticated request would be a far
  worse thing than a server that refuses to start.

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

- **REQ-6** — Tool *input* errors (unknown tool, missing argument) are JSON-RPC
  errors; tool *runtime* failures return `isError: true` with the message in
  `content` (per MCP). Unparseable `song` JSON strings count as validation
  results (`{ok:false, errors:[…]}`), not crashes.

- **REQ-7** — `.mcp.json` at the repo root registers the server for Claude
  Code (`node scripts/mcp/websynth-mcp.mjs`); the README documents wiring for
  other MCP clients. `scripts/mcp/dist/` is gitignored.

- **REQ-8** — (v6) **A song that validates can still be wrong, and the agent is
  told.** `validate_song` returns `{ok, errors[], warnings[]}` and `save_song`
  adds `warnings[]` to its success payload, carrying
  [untrusted-input](untrusted-input.md) REQ-12's unresolvable automation targets.
  This closes the authoring loop's one silent hole: an `xy` or `motionTracks`
  target naming a parameter that does not exist used to come back
  `{ok:true, errors:[]}` and then move nothing at play time, which an agent has
  no way to discover — it cannot hear the result. `expand_song` keeps returning
  the song **text alone** (its output is parsed, so a wrapper object would be a
  breaking change); its description points at `validate_song` for warnings.
  Warnings never set `ok:false` — [untrusted-input](untrusted-input.md) REQ-12
  owns why.

- **REQ-9** — (v8) **The HTTP transport is Streamable HTTP, stateless.**
  `createRequestListener({dispatch, version, origins, limits})` returns a
  `(req, res)` handler — no socket needed to test it. The contract:

  | Request | Response |
  | --- | --- |
  | `POST` + `content-type: application/json`, body one JSON-RPC message | `200 application/json`, the JSON-RPC response |
  | `POST` where `dispatch` returns `null` (a notification) | `202`, empty body |
  | `POST` with an unparseable body | `400` + JSON-RPC `-32700` |
  | `POST` with any other content type | `415` |
  | body over `MAX_MCP_REQUEST_BYTES` | `413`, socket destroyed **mid-stream** |
  | over `MAX_MCP_REQUESTS_PER_MINUTE` for that IP | `429` + `Retry-After` |
  | `Origin` present and not allowlisted | `403` |
  | `GET` / `DELETE` on the MCP path | `405` + `Allow: POST` |
  | `OPTIONS` | `204` + CORS preflight headers |
  | `GET /healthz` | `200 {"ok":true,"version":"…"}` |
  | any other method | `405` + `Allow: POST` |

  There is deliberately **no `404`**. REQ-9e means the path is not routed on, so
  the server has no notion of a path being "wrong" — every non-`POST` is
  answered by method, not by location.

  - **REQ-9a** — **No session.** No `Mcp-Session-Id` is ever issued. There is no
    per-connection state to key one on: the single lazily-created `ParamBus`
    inside `makeTools` is read-only and shared per process. The MCP spec permits
    the omission, and it means no session table to bound and no eviction policy.
  - **REQ-9b** — **No SSE.** Every response is a single JSON body, so nothing
    depends on a reverse proxy declining to buffer. `GET` answering `405` is the
    spec's sanctioned way to say "this server offers no server-initiated stream",
    and it doubles as the reason the service worker can never cache this path
    ([pwa-install](pwa-install.md) REQ-6 — a 405 is not a cacheable 200).
  - **REQ-9c** — **`Origin` absent is allowed; `Origin` present must match.**
    Claude calls server-side and sends none, so requiring the header would break
    the only client that matters. When a browser *does* send one it must be in
    the allowlist (the published site, plus loopback for the MCP Inspector), else
    `403`. That is the spec's DNS-rebinding defence, and it is a browser-only
    concern by construction.
  - **REQ-9d** — **`MCP-Protocol-Version` is ignored.** Not read and discarded —
    never consulted. `rpc.mjs` behaves identically at every revision it knows and
    `initialize` already negotiates (REQ-2), so there is nothing the header could
    change; validating it would only give a client newer than this file a way to
    be refused for no reason.
  - **REQ-9e** — **The path is not matched.** Any path accepts the `POST`
    (`/healthz` excepted), because the same process is reached at `/mcp` behind
    the production proxy, at `/` on the origin server, and at whatever a
    developer types locally. Hard-matching `/mcp` would make the deployment
    topology a code constant.

- **REQ-10** — (v8) **The remote profile is read-only, and named.**
  `makeTools(core, {allowWrites})` defaults `allowWrites` to **`true`**, so the
  stdio profile and every existing test are untouched. The HTTP entries pass
  `false`, which omits exactly `save_song` and `save_preset` and leaves these
  eight, in this order: `get_params`, `get_song_format`, `validate_song`,
  `expand_song`, `make_share_link`, `get_preset_format`, `validate_preset`,
  `expand_preset`.

  This is not defensive trimming. The write tools are *meaningless* remotely:
  REQ-5c contains a write to the server's working directory, and on a shared
  public host that is not a directory any caller can retrieve a file from. It
  would be a disk-filling vector in exchange for an artifact nobody collects.
  `make_share_link` is the remote answer to "give me the result" — it returns a
  URL that loads the song, which a stranger can actually open.
  ADR-020 owns the reasoning, including why read-only is what makes authless
  defensible.

- **REQ-11** — (v8) **The public endpoint is bounded, not authenticated.** There
  is no auth (ADR-020); the bounds are the whole defence, and they live in
  `src/state/limits.ts` like every other bound in this repo
  ([untrusted-input](untrusted-input.md) REQ-3/REQ-14): `MAX_MCP_REQUEST_BYTES`,
  `MAX_MCP_REQUESTS_PER_MINUTE`, `MAX_MCP_RATE_KEYS`, `MAX_MCP_REQUEST_MS`.
  Three rules make them real:
  - The body cap is enforced **while reading**, against a running byte count, so
    an oversized upload dies in transit rather than after being buffered — the
    same rule `compression.ts` and `zip.ts` obey for the same reason.
  - **The rate limiter is itself bounded.** Its fixed-window map holds at most
    `MAX_MCP_RATE_KEYS` entries and evicts; an unbounded IP-keyed map on a public
    endpoint is a memory-exhaustion vector, which is precisely the class of bug
    ADR-015 exists to catch. The limiter must not become the leak.
  - The client IP is the **first** `X-Forwarded-For` hop, falling back to
    `socket.remoteAddress`. That is only trustworthy because the deployed nginx
    *overwrites* the header rather than appending
    (`proxy_set_header X-Forwarded-For $remote_addr`) — a fact the code cannot
    enforce, so it is written down beside the directive in `DEPLOYMENT.md`.

  A rejected request is an **HTTP status**, not a JSON-RPC error — the one
  exception being the `-32700` parse-error body, which the protocol requires.

## Technical design

### Contract / public interface

```yaml
rpc.mjs:
  createDispatcher: '({name, version, tools}) => async (msg) => response | null'
  # tools: [{name, description, inputSchema, handler(args) => Promise<{content, isError?}>}]
tools.mjs:
  makeTools: '(core, {baseUrl?, cwd?, allowWrites?}?) => Tool[]'   # allowWrites defaults true (REQ-10)
core.mjs:
  loadCore: '({selfBuild}?) => Promise<Core>'   # selfBuild:false throws on a missing bundle (REQ-3)
http.mjs:
  createRequestListener: '({dispatch, version, origins?, limits?}) => (req, res) => void'
song-core-entry.ts: 're-exports the pure core (REQ-4) + the MAX_MCP_* limits'
websynth-mcp.mjs:      'stdio loop: readline → JSON.parse → dispatch → stdout line'
websynth-mcp-http.mjs: 'local HTTP entry (self-building)'
app.js:                'deployed HTTP entry (prebuilt bundle only)'
```

### Layer touchpoints & ordering

```yaml
stdio (local):   websynth-mcp.mjs -> loadCore({selfBuild:true})       # REQ-1a, REQ-3
                 -> makeTools(core, {cwd})                            # 10 tools
                 -> createDispatcher -> readline loop
http  (local):   websynth-mcp-http.mjs -> loadCore({selfBuild:true})  # REQ-1b
                 -> makeTools(core, {allowWrites:false})              # 8 tools, REQ-10
                 -> createDispatcher -> createRequestListener -> :8787
http  (public):  app.js -> loadCore({selfBuild:false})                # REQ-3, throws if absent
                 -> makeTools(core, {allowWrites:false})
                 -> createDispatcher -> createRequestListener
                 -> Passenger -> nginx `location ^~ /mcp`             # DEPLOYMENT.md
```

`rpc.mjs`/`tools.mjs` never touch a transport themselves, so they stay pure for
unit tests, and `http.mjs` takes `dispatch` as an argument for the same reason.
Order matters in one direction only: the bounds (REQ-11) are applied **before**
the body is read, and the body is parsed before `dispatch` is ever called.

### Persistence

`scripts/mcp/dist/song-core.mjs` (gitignored build artifact) and the
`save_song` output file. Nothing else — and the HTTP transport writes neither
(REQ-10), so the deployed server touches no disk at all after boot.

## Scenarios (BDD)

```gherkin
Scenario: Initialize handshake
  Given the server is running over stdio
  When the client sends initialize with protocolVersion "2025-06-18"
  Then the response echoes "2025-06-18", capabilities {tools:{}}, and serverInfo
# pinned by: tests/mcp/integration.test.ts (over real stdio), tests/mcp/rpc.test.ts

Scenario: Validation failure is a successful tools/call
  When tools/call validate_song receives a song with a bad note
  Then the response has isError absent/false
  And its text payload is {"ok":false,"errors":[…]} naming the bad field
# pinned by: tests/mcp/tools.test.ts, tests/mcp/integration.test.ts

Scenario: expand_song returns canonical compact JSON
  When tools/call expand_song receives a valid author-dialect song
  Then the text payload parses as format "websynth-song", version 3
       (that song uses no post-v3 field — see song-authoring-dialect.md REQ-12;
        this is the expansion's floor, not the canonical version)
  And it passes validate_song
# pinned by: tests/mcp/tools.test.ts (expand_song)

Scenario: A preset with an invented parameter id fails validation (v2)
  When tools/call validate_preset receives params naming "osc1.shape"
  Then isError is absent/false
  And the payload is {"ok":false,"errors":[…]} naming that id
# pinned by: tests/mcp/tools.test.ts, tests/mcp/integration.test.ts

Scenario: save_preset picks the extension from the payload (v2)
  When tools/call save_preset receives a websynth-preset-bank payload
  Then the written path ends in .bank.websynth.json
  And its params are expanded to the complete patch
# pinned by: tests/mcp/tools.test.ts (save_preset)

Scenario: A save cannot escape the working directory (v4)
  Given save_song (or save_preset) called with dir '../..' or an absolute path
  Then the call fails and no file or directory is created
  And dir 'sub/dir' still writes normally
# pinned by: tests/mcp/tools.test.ts

Scenario: A dead automation target comes back as a warning (v6, REQ-8)
  Given a song whose xy.x is "filter.cuttoff" and whose motionTracks names "not.a.param"
  When validate_song runs
  Then ok is true and errors is empty
  And warnings names both ids, so the agent can fix a lane it cannot hear
# pinned by: tests/mcp/tools.test.ts

Scenario: Unknown method
  When the client sends method "resources/list"
  Then the response error code is -32601
# pinned by: tests/mcp/rpc.test.ts, tests/mcp/integration.test.ts

Scenario: The same handshake works over HTTP (v8, REQ-1/REQ-9)
  Given the HTTP transport is serving
  When a client POSTs initialize, then tools/list, then tools/call validate_song
  Then each answers 200 application/json with the same JSON-RPC payload stdio gives
  And no Mcp-Session-Id header is ever set
# pinned by: tests/mcp/http.test.ts

Scenario: A notification over HTTP is accepted, not answered (v8, REQ-9)
  When a client POSTs notifications/initialized
  Then the response is 202 with an empty body
# pinned by: tests/mcp/http.test.ts

Scenario: The remote profile has no write tools (v8, REQ-10)
  When tools/list runs against the HTTP transport
  Then it lists exactly the eight read-only tools, in REQ-10's order
  And save_song and save_preset are absent
  And tools/call save_song answers -32602 (unknown tool), never a write
# pinned by: tests/mcp/http.test.ts, tests/mcp/tools.test.ts

Scenario: The local profile is unchanged by the remote one (v8, REQ-10)
  When makeTools is called with no allowWrites option
  Then it returns all ten tools in the original order
# pinned by: tests/mcp/tools.test.ts, tests/mcp/integration.test.ts

Scenario: An oversized body dies in transit (v8, REQ-11)
  Given a POST whose body exceeds MAX_MCP_REQUEST_BYTES
  Then the response is 413
  And the request was refused while streaming — the whole body is never buffered
# pinned by: tests/mcp/http.test.ts

Scenario: A flood is rate-limited per IP (v8, REQ-11)
  Given MAX_MCP_REQUESTS_PER_MINUTE requests from one X-Forwarded-For address
  When one more arrives from that address
  Then it answers 429 with Retry-After
  And a request from a different address still answers 200
# pinned by: tests/mcp/http.test.ts

Scenario: The rate limiter cannot itself be made to leak (v8, REQ-11)
  Given requests from more distinct addresses than MAX_MCP_RATE_KEYS
  Then the limiter's tracked-key count never exceeds MAX_MCP_RATE_KEYS
# pinned by: tests/mcp/http.test.ts

Scenario: Claude's own request has no Origin, and is allowed (v8, REQ-9c)
  When a POST arrives with no Origin header at all
  Then it answers 200
  But a POST with Origin "https://evil.example" answers 403
# pinned by: tests/mcp/http.test.ts

Scenario: GET offers no stream, so nothing can cache it (v8, REQ-9b)
  When a client GETs the MCP path
  Then it answers 405 with Allow: POST
  And the service worker's strategyFor classifies that path as passthrough
# pinned by: tests/mcp/http.test.ts, tests/pwa/sw.test.ts

Scenario: Self-build keeps stdout protocol-pure
  Given a checkout with no scripts/mcp/dist bundle
  When the server starts and a client completes the handshake
  Then every stdout line parses as a JSON-RPC message
# pinned by: tests/mcp/integration.test.ts (the self-build) — its beforeAll
#            deletes scripts/mcp/dist, so every run takes this path

Scenario: A rebuild leaves node_modules replaceable (v7, REQ-3, regression)
  Given a stale scripts/mcp/dist bundle
  When the server starts and rebuilds it
  Then the build ran in a child process that has since exited
  And the long-running server holds no native module under node_modules open
  And `npm ci` can replace node_modules while that server is still connected
# NOT AUTOMATED. tests/mcp/integration.test.ts does now exercise the self-build
# (it deletes the bundle first), but it cannot pin THIS claim: asserting that
# node_modules is replaceable means running `npm ci` against the live checkout
# while the server holds it, which would tear the suite's own dependencies out
# from under it. Verify by hand: delete scripts/mcp/dist, start the server, then
# run `npm ci` while it stays connected. See Open questions.
```

## Tests & verification

- Unit: `tests/mcp/rpc.test.ts` (dispatch), `tests/mcp/tools.test.ts` (tools
  against the real src core, imported directly under Vitest — no bundle
  needed) — `npm test`
- Integration: `tests/mcp/integration.test.ts` — deletes `scripts/mcp/dist`,
  spawns the server so it self-builds (REQ-1/REQ-3), then drives initialize →
  tools/list → validate_song over real stdio, asserting every stdout line is a
  JSON-RPC frame. The bundle is deliberately NOT pre-built: that used to be how
  the suite kept itself fast, but the build has to run either way, and running
  it inside the server is what makes the protocol-purity claim testable.
- Unit (v8): `tests/mcp/http.test.ts` — drives `createRequestListener` over a
  real ephemeral `node:http` server (the bounds are about sockets, so a fake
  `req`/`res` would pin the wrong thing): the handshake, `202` on a
  notification, `400`/`-32700`, `415`, `405` + `Allow`, `413` at the byte cap,
  `429` at the rate cap, the key-count ceiling, `Origin` present/absent, and the
  eight-tool profile.
- Manual: in Claude Code (this repo's `.mcp.json`) run `get_song_format`, feed
  a broken author file to `validate_song`, then `save_song` and import the
  written file in the app. Same round for `get_preset_format` →
  `validate_preset` (try a bogus id) → `save_preset` → Preset ▸ Import.
- Manual (v8, HTTP): `npm run start:mcp:http`, then
  `claude mcp add --transport http websynth-local http://127.0.0.1:8787/mcp` and
  `/mcp` to confirm the connection; call `get_song_format` and
  `make_share_link`, and open the returned link. Against production, the check
  that actually matters is the *static site*: after the nginx directive lands,
  `/worklets/*.js`, `/sw.js` and `/site.webmanifest` must still be served by
  nginx from `dist/` with unchanged content types, and the app must still make
  sound — `audioWorklet.addModule` throws on a wrong MIME type, so audio
  starting is the real assertion. Steps in `DEPLOYMENT.md`.

## Open questions / future

- **Half of REQ-3 stays unpinned.** `tests/mcp/integration.test.ts` now starts
  the server against a deleted `dist/`, so the child-process build itself runs
  and its protocol purity is asserted. What no test can reach is the consequence
  it exists for: that `npm ci` may replace `node_modules` while a long-lived
  server is connected. Asserting it means running `npm ci` against the checkout
  the suite is itself running from. It stays a manual check.

- npm-publishable standalone package (`npx websynth-mcp`). (v8) The hosted
  endpoint answers most of what this was for — reach without a clone — so what
  is left for a package is offline use and the two write tools, which is a much
  narrower case than it was.
- A `render_song` tool once an offline render path exists outside the browser.
  Note it would be the first tool that cannot answer in milliseconds, so it is
  also the first thing that would force REQ-9b's no-SSE decision to be revisited
  (ADR-020's last trade-off).
- **The rate limit is per-process, per-IP, in memory.** One process behind one
  proxy makes that exact; it would not survive being scaled to two. If the
  endpoint ever runs more than one instance, the limiter needs shared state or
  the bound moves to nginx (`limit_req_zone`), which is where it would probably
  belong anyway.
