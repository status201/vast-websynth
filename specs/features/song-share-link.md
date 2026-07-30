# Song share links (URL ingest + Copy Link)

```yaml
id: song-share-link
status: implemented
version: 3   # v3: https-only songUrl + consent dialog + payload/fetch caps (REQ-7/8)
owner: state
related:
  - song-mode
  - song-authoring-dialect
  - project-export
  - untrusted-input
  - dialog
  - ../decisions/adr-003-no-runtime-dependencies
  - ../decisions/adr-015-untrusted-input-is-bounded
source:
  - src/state/song-link.ts                # parseSongLink, encode/decodeSongPayload, buildShareUrl
  - src/main.ts                           # boot hook (next to the launchQueue consumer)
  - src/ui/components/export-song-modal.ts # the Copy Link action (song-share-link testid)
  - src/ui/panels/song-panel.ts           # wires makeShareUrl into the export modal
  - src/utils/compression.ts              # shared deflate-raw helpers (reused, unchanged)
```

## Background / Why

Sharing a song currently means exporting a `.json` and sending the file. A
share **URL** lets a song travel as a link — pasteable in chat, embeddable by
AI agents, clickable from anywhere. The payload rides in the **hash fragment**
(never sent to the server: out of server logs, and static hosts need no route
handling): `#song=<payload>` embeds the song itself, `#songUrl=<https url>`
points at a hosted song/project file. Both funnel into the same import path as
the Import button, so canonical files, authoring-dialect files, and (via
`songUrl`) project zips all work.

## Requirements

- **REQ-1** — `parseSongLink(hash)` recognises `#song=<payload>` (embedded,
  `{kind:'data'}`) and `#songUrl=<https url>` (fetched, `{kind:'url'}`);
  anything else returns `null`. **`https:` only** (v3): a `http://`,
  `javascript:`, `file://` or protocol-relative `songUrl` is ignored. Plain
  `http` was accepted by the original `https?` test, which made
  `#songUrl=http://192.168.1.1/…` a zero-click LAN probe from the victim's
  browser ([untrusted-input](untrusted-input.md) REQ-7).
- **REQ-2** — `encodeSongPayload(json)` deflate-raws the UTF-8 bytes and
  base64url-encodes them. When the platform lacks Compression Streams
  (`hasCompression()` false, e.g. jsdom), it falls back to `'j:'` +
  base64url(utf8) — unambiguous because base64url never contains `:`.
  `decodeSongPayload` inverts both forms. Byte→binary-string conversion is
  chunked (no spread on large arrays).
- **REQ-3** — At boot (`main.ts`, beside the launchQueue consumer) a present
  song link is decoded/fetched and driven through `UiBridge.importSongBytes` —
  the same one-import-path as the Import button and OS file launches
  (pwa-install.md REQ-7), so parse errors surface in the existing import-error
  dialog. Applying is pure state, so it works behind the start modal. Errors use
  the shared `alertDialog`, **never the native `alert()`** (v3 — it was `alert()`,
  which contradicted this requirement and put payload-derived text in browser
  chrome).
- **REQ-7** — **A fetch needs consent (v3).** `#song=` carries its own payload —
  no network, no third party — so it keeps applying at boot, unprompted.
  `#songUrl=` first shows a `confirmDialog` naming the **target origin**;
  declining leaves the hash in place and applies nothing. That prompt is raised
  **from the start gesture, not at boot**: applying a song is pure state and
  works behind the start modal, but a *dialog* raised there renders underneath
  it and cannot be reached — the same reason the restored-clips toast waits
  (sample-persistence.md REQ-8). The request is then
  `credentials: 'omit'`, `redirect: 'error'`, `mode: 'cors'`, with a timeout, and
  a `Content-Length` over `MAX_SONG_JSON_BYTES` is refused before the body is
  buffered. Without this, one link made any visitor's browser issue an
  attacker-chosen GET at page load.
- **REQ-8** — **The payload is capped (v3).** `decodeSongPayload` inflates
  through `inflateRaw(bytes, MAX_SONG_JSON_BYTES)`, which throws **during** the
  read rather than after — deflate's ~1032:1 ratio otherwise lets an
  address-bar-sized hash expand to gigabytes ([untrusted-input](untrusted-input.md)
  REQ-2).
- **REQ-4** — On a **successful** import the hash is consumed via
  `history.replaceState(null, '', pathname + search)`; on failure the hash
  stays in the address bar so the user can copy/inspect/retry it.
  `SongPanel.importBytes` (and the `UiBridge` hook) therefore resolve to a
  boolean success flag.
- **REQ-5** — The export modal gains a **Copy Link** action (testid
  `song-share-link`): `Song.capture` → `toJSON` → `encodeSongPayload` →
  `buildShareUrl(origin, payload)` → clipboard via the shared
  `copyText`/`flashCopied`. The action does not close the modal. It is
  **disabled while the Project (.zip) kind is selected** (v2): a share URL
  embeds only the song JSON and can never carry the project's sampler audio,
  so offering it there would mislead — the disabled button's `title` explains
  why and points back to Song (.json). Selecting Song (.json) re-enables it
  and restores its normal tooltip.
- **REQ-6** — `buildShareUrl` produces `<origin>/#song=<payload>`. Payloads are
  base64url so they never need percent-encoding.

## Technical design

### Contract / public interface

```ts
// src/state/song-link.ts (pure; no DOM beyond TextEncoder/TextDecoder + btoa/atob)
export type SongLink = { kind: 'data'; payload: string } | { kind: 'url'; url: string };
export function parseSongLink(hash: string): SongLink | null;
export async function encodeSongPayload(json: string): Promise<string>;
export async function decodeSongPayload(payload: string): Promise<string>; // throws on undecodable payloads
export function buildShareUrl(origin: string, payload: string): string;
```

### Layer touchpoints & ordering

- `song-link.ts` reuses `deflateRaw`/`inflateRaw`/`hasCompression` from
  `src/utils/compression.ts` (feature-detected on `globalThis`).
- `main.ts` boot: `parseSongLink(location.hash)` → data: `decodeSongPayload` →
  UTF-8 bytes; url: `fetch` → bytes (the filename tail keeps a `.zip`
  extension working through the magic-byte sniff). Then
  `bridge.importSongBytes(bytes, name)`; clear the hash only on `true`.
- `song-panel.ts` passes `makeShareUrl` to `openExportSongModal`; the modal
  owns the button + clipboard flash.

### Persistence

None. The hash is consumed on success; the payload is never stored.

## Scenarios (BDD)

```gherkin
Scenario: A #song= link loads at boot
  Given a URL whose hash is #song=<deflate+base64url of a valid song JSON>
  When the app boots
  Then the song is applied (bus params reflect it)
  And the hash is cleared from the address bar

Scenario: An authoring-dialect payload works end-to-end
  Given a #song= payload encoding a websynth-song-author file
  When the app boots
  Then the expanded song is applied

Scenario: A bad payload leaves the hash intact
  Given a #song= payload that decodes to invalid JSON
  When the app boots
  Then the import-error dialog appears
  And the hash is NOT cleared

Scenario: Copy Link puts a share URL on the clipboard
  Given the export modal is open
  When the user clicks Copy Link (song-share-link)
  Then the clipboard holds "<origin>/#song=<payload>"
  And decoding that payload round-trips the captured song JSON

Scenario: Copy Link is disabled for a Project (.zip) export (v2)
  Given the export modal is open with sampler audio loaded
  When the user selects the Project (.zip) kind
  Then the Copy Link button is disabled
  And its title explains a link cannot include sampler audio
  When the user selects Song (.json) again
  Then Copy Link is enabled with its normal tooltip
# pinned by: tests/ui/export-song-modal.test.ts

Scenario: A songUrl link asks before it fetches (v3)
  Given a URL whose hash is #songUrl=https://example.com/song.json
  When the app boots and the user taps to start
  Then a confirm dialog names the origin "example.com"
  And nothing is requested until it is accepted
  And declining leaves the hash intact and fetches nothing
# pinned by: e2e/song-link.spec.ts

Scenario: A non-https songUrl is ignored (v3)
  Given a hash of #songUrl=http://192.168.1.1/x, javascript:alert(1), file:///etc,
    or //evil.example/song.json
  Then parseSongLink returns null for every one
# pinned by: tests/state/song-link.test.ts

Scenario: An oversized payload is refused mid-inflate (v3)
  Given a #song= payload that inflates past MAX_SONG_JSON_BYTES
  When decodeSongPayload runs
  Then it throws before materializing the whole output
  And the hash is NOT cleared
# pinned by: tests/state/song-link.node.test.ts

Scenario: Round-trip encode/decode
  Given any JSON string
  When encodeSongPayload then decodeSongPayload run
  Then the original string returns (with or without Compression Streams)
# pinned by: tests/state/song-link.test.ts, tests/state/song-link.node.test.ts, e2e/song-link.spec.ts
```

## Tests & verification

- Unit: `tests/state/song-link.test.ts` (the `'j:'` fallback path, pinned by
  stubbing Compression Streams away — modern jsdom/Vitest environments expose
  them), `tests/state/song-link.node.test.ts` (`@vitest-environment node` —
  real deflate round-trip), `tests/ui/export-song-modal.test.ts` (Copy Link
  disabled for the Project kind, v2) — `npm test`
- E2E: `e2e/song-link.spec.ts` (payload built with `node:zlib.deflateRawSync`,
  `page.goto('/#song=…')`, asserts via `window.__synth.bus.get` + hash cleared;
  author-dialect payload; Copy Link with clipboard permissions) — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- A QR code for the share URL (the WiFi-sync pair modal already renders QR).
- A **remembered per-origin allow-list** for `#songUrl=`, so a host the user
  already trusted stops prompting. (The size cap and the consent gate that this
  bullet used to defer both landed in v3 — see REQ-7/REQ-8.)
- Streaming the fetched body so an over-cap response is abandoned mid-flight,
  rather than trusting a `Content-Length` a hostile server may simply omit.
