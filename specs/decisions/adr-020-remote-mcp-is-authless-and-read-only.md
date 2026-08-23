# ADR-020 — The public MCP endpoint is authless, read-only, and hand-rolled

```yaml
id: adr-020-remote-mcp-is-authless-and-read-only
status: accepted
date: 2026-08-23
deciders: core
related:
  - ../features/mcp-server
  - ../features/untrusted-input
  - ../features/pwa-install
  - adr-003-no-runtime-dependencies
  - adr-015-untrusted-input-is-bounded
```

> ADR `status` is its own decision lifecycle and is **not** the feature-spec
> `draft | active | implemented`. A decision is `proposed`, then `accepted`; a
> later ADR can mark it `superseded by adr-XXX` or `deprecated`. Records are
> append-only — supersede, don't rewrite.

## Context / Forces

The MCP server was local-only: `.mcp.json` starts `node
scripts/mcp/websynth-mcp.mjs` over stdio, so the only people who could reach the
authoring loop were those who had cloned the repo and run `npm install`. That is
backwards for what the tools actually do — they serve the *published* authoring
guides, the *published* parameter catalogue, and validators for a *published*
document format. Nothing in them is private, and nothing in them is local.

Making it public forces three questions at once, and they are entangled enough
that answering them separately produces an incoherent server:

- **Who may call it?** Claude supports remote MCP servers with OAuth 2.1 + DCR,
  with a static bearer header, or with no authentication at all (`none`).
- **What may it do?** Two of the ten tools (`save_song`, `save_preset`) write
  files. `containedDir` contains those writes to the server's working directory
  — a rule written for a single trusted local caller.
- **What implements the transport?** Remote MCP is Streamable HTTP.
  `@modelcontextprotocol/sdk` implements it; ADR-003 says this repo has no
  runtime dependencies.

The host is a shared Plesk box that also serves the static PWA, which adds a
fourth force: whatever is chosen must not put a Node process in front of the
document root. `audioWorklet.addModule` throws on a non-JavaScript MIME type, so
a hosting change that alters how `/worklets/*.js` is served is not a deployment
detail — it is silence instead of audio.

## Decision

**Three decisions, taken together, because each one is only defensible given the
other two.**

1. **The public endpoint is authless** (`none`). It is protected by bounds, not
   by identity: a body cap, a per-IP fixed-window rate limit, a request timeout,
   and an `Origin` allowlist. Absent `Origin` is *allowed* — Claude calls
   server-side from `160.79.104.0/21` and sends none; the check exists for the
   DNS-rebinding case, which is a browser case.

2. **The remote profile is read-only.** `makeTools` gains `allowWrites`,
   defaulting to `true` so the stdio server is untouched. The HTTP entry passes
   `false`, which omits exactly `save_song` and `save_preset`. The remaining
   eight tools are pure functions of their arguments. `make_share_link` is the
   remote answer to "give me the artifact": it returns a URL that loads the song,
   which is strictly more useful to a remote caller than a path on a machine they
   cannot see.

3. **The transport is hand-rolled on `node:http`**, like the stdio one.
   `createDispatcher` in `rpc.mjs` was already transport-agnostic — it maps a
   parsed message to a response object — so the HTTP half is framing, bounds and
   status codes, and nothing else. The server is **stateless**: it issues no
   `Mcp-Session-Id` and offers no SSE stream, answering `GET` with `405`.

Decision 2 is what makes decision 1 safe. An authless endpoint that writes files
would be indefensible; an authless endpoint that evaluates pure functions over a
public document format is a calculator. Decision 3 is what keeps decision 1
*small* enough to audit — the whole trust boundary is one file.

## Alternatives considered

- **OAuth 2.1 + Dynamic Client Registration** — rejected as disproportionate.
  OAuth answers "which user is this, and what may they see"; these tools hold no
  user data, no per-user state and no private resource, so every consent screen
  would guard a validator. It would mean a user store, an authorization server,
  a consent page and refresh-token rotation — several hundred lines of security
  code whose failure modes are worse than the thing it protects. Revisit only if
  a tool ever holds something that belongs to somebody.
- **A shared static bearer token** (`static_headers`) — rejected because it buys
  nothing here and costs reach. It would not make the tools safer (they are pure
  either way); it would only make the connector un-addable by anyone the token
  had not been handed to, which defeats the point of publishing it. It is also
  beta on the hosted Claude surfaces, so it would be a support burden.
- **Keep the write tools and sandbox them per-caller** — rejected: there is no
  caller identity to key a sandbox on (decision 1), and even with one, a file on
  the server is not a file the caller can retrieve. It would be a disk-filling
  vector in exchange for an artifact nobody can collect.
- **`@modelcontextprotocol/sdk` for the transport** — rejected by ADR-003, and
  independently by proportion: `rpc.mjs` implements the protocol this server
  needs in 83 lines, and the HTTP half is a request listener. Taking the SDK
  would introduce the repo's first runtime dependency, and a transitive tree, to
  a process that is exposed to the internet.
- **Sessions with `Mcp-Session-Id` and an SSE stream** — rejected: there is no
  per-connection state to key a session on (the single `ParamBus` inside
  `makeTools` is read-only and shared per process), and no server-initiated
  message to push. Statelessness also means no session table to bound, no
  eviction policy, and no SSE connection surviving a reverse proxy's buffering.
  The spec explicitly permits both omissions.
- **Run the Node app on `vast.status201.com` itself** — rejected. Enabling
  Plesk's Node.js extension on a domain puts Passenger in front of the whole
  document root, which puts the MIME type of `/worklets/*.js`, the root scope of
  `/sw.js` and `/site.webmanifest` at risk. The endpoint is proxied in at
  `location ^~ /mcp` instead, so every other path is served by the same nginx,
  from the same `dist/`, exactly as before.

## Consequences

- **Good:** anyone can add the connector — `claude mcp add --transport http
  websynth https://vast.status201.com/mcp` — with no clone, no `npm install`, no
  account and no token. The authoring loop is now a property of the *published
  instrument*, not of the checkout.
- **Good:** the trust boundary is one file (`scripts/mcp/http.mjs`) and one set
  of constants in `src/state/limits.ts`. There is no session table, no token
  store and no credential to leak or rotate.
- **Good:** the stdio server is unchanged. `allowWrites` defaults to `true`, so
  the local ten-tool profile and its tests are untouched by any of this.
- **Trade-off:** the two profiles differ, so a tool that exists locally may be
  absent remotely. An agent that learned `save_song` against the local server
  will not find it against the public one. This is why REQ-10 pins the remote
  tool set by name rather than by "whatever isn't a write".
- **Trade-off:** an authless endpoint is abusable by definition. The bounds are
  the whole defence, which makes them load-bearing in a way the app's limits are
  not: a too-generous cap here is a bill, not just a slow parse. They are
  deliberately tighter than the in-app equivalents —
  `MAX_MCP_REQUEST_BYTES` is 1 MB against `MAX_SONG_JSON_BYTES`' 8 MB.
- **Trade-off:** the rate limiter keys on the first `X-Forwarded-For` hop, which
  is only trustworthy because the nginx directive **overwrites** that header
  (`proxy_set_header X-Forwarded-For $remote_addr`) rather than appending to it.
  That is a deployment detail the code cannot enforce, so it is written into
  `DEPLOYMENT.md` next to the directive, and it is the first thing to check if
  the limiter ever looks ineffective.
- **Trade-off:** no SSE means no progress reporting and no server-initiated
  notifications, ever, without revisiting this. For tools that return in
  milliseconds that costs nothing; a future `render_song` would have to.
