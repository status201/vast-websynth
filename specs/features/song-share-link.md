# Song share links (URL ingest + Copy Link)

```yaml
id: song-share-link
status: implemented
version: 1
owner: state
related:
  - song-mode
  - song-authoring-dialect
  - project-export
  - ../decisions/adr-003-no-runtime-dependencies
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
  `{kind:'data'}`) and `#songUrl=<http(s) url>` (fetched, `{kind:'url'}`);
  anything else returns `null`. A non-http(s) `songUrl` is ignored (null).
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
  dialog. Applying is pure state, so it works behind the start modal.
- **REQ-4** — On a **successful** import the hash is consumed via
  `history.replaceState(null, '', pathname + search)`; on failure the hash
  stays in the address bar so the user can copy/inspect/retry it.
  `SongPanel.importBytes` (and the `UiBridge` hook) therefore resolve to a
  boolean success flag.
- **REQ-5** — The export modal gains a **Copy Link** action (testid
  `song-share-link`): `Song.capture` → `toJSON` → `encodeSongPayload` →
  `buildShareUrl(origin, payload)` → clipboard via the shared
  `copyText`/`flashCopied`. The action is independent of the export-kind
  selection and does not close the modal.
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
  real deflate round-trip) — `npm test`
- E2E: `e2e/song-link.spec.ts` (payload built with `node:zlib.deflateRawSync`,
  `page.goto('/#song=…')`, asserts via `window.__synth.bus.get` + hash cleared;
  author-dialect payload; Copy Link with clipboard permissions) — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- A QR code for the share URL (the WiFi-sync pair modal already renders QR).
- Optional `#songUrl=` allow-list / size cap if abuse ever shows up.
