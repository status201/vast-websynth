# Untrusted input (the trust boundary: links, files, zips, peers)

```yaml
id: untrusted-input
status: implemented
version: 3   # v3: REQ-12 — an unresolvable automation target warns instead of
             #     rejecting; the validator gains a `warnings` channel
             # v2: REQ-9 — "destroy" means a *difference*; an identical slot is
             #     not an overwrite worth prompting for
owner: core
related:
  - architecture
  - song-mode
  - song-share-link
  - project-export
  - paste-import
  - song-authoring-dialect
  - webrtc-sync
  - mcp-server
  - session-autosave
  - transport
  - ../decisions/adr-015-untrusted-input-is-bounded
  - ../decisions/adr-003-no-runtime-dependencies
  - ../decisions/adr-004-patternstore-separate-from-parambus
source:
  - src/state/limits.ts                 # the limit constants — single source of truth
  - src/utils/compression.ts            # inflateRaw(bytes, maxBytes)
  - src/utils/zip.ts                    # entry/total/count caps + declared-size pre-flight
  - src/state/song-link.ts              # https-only songUrl; payload cap
  - src/state/params.ts                 # paramIds() — the registered id set (REQ-12)
  - src/state/song-validate.ts          # note/chain/param bounds; reserved-key refusal;
                                        #   unresolvable automation targets (REQ-12)
  - src/state/song-author.ts            # the same bounds for the dialect
  - src/state/song.ts                   # Song.parse error boundary
  - src/audio/transport/clock.ts        # listener isolation + NaN-safe setBpm
  - src/audio/oscillator.ts             # non-finite Hz guard
  - src/main.ts                         # songUrl consent + hardened fetch
  - src/audio/webrtc-sync-transport.ts  # wire type guard
  - scripts/mcp/tools.mjs               # save_song/save_preset dir containment
```

## Background / Why

A song is a **shareable document**, not just a save file. It arrives as a
`#song=` URL, a `#songUrl=` remote fetch, a `.json` file, a pasted AI reply, or a
`.websynth.zip` — all authored by whoever sends them, and the two link forms are
applied **at boot with no user interaction**. Anything that parses one of those
is a trust boundary.

Most of that boundary was already sound, and this spec exists partly to record
*that*, so it is not re-litigated: there is **no XSS** (every data-derived string
reaches the DOM through `textContent`; every `innerHTML` write is a clear or an
authored literal), **no `eval`/`Function`/`document.write`**, and **no CSRF
surface** (no server, no session, no cookie). `Song.parse` is a single import
funnel every surface routes through, and `ParamBus.set` clamps every *registered*
param to `def.min/max` — so an imported song can never be louder, more resonant
or more feedback-y than the UI itself allows.

What was missing was **magnitude**. [ADR-007](../decisions/adr-007-songfile-additive-versioning.md)
makes the validator lenient about *shape* so old files keep loading, and that
leniency was mistakenly extended to *size and range*:

- `SeqStep.note` was checked `Number.isFinite` but not `0..127`. `midiToHz(1e6)`
  is `Infinity`, `AudioParam.setValueAtTime(Infinity)` throws, and the throw
  escaped an un-try/caught listener loop in `Clock.tick` — which then re-entered
  the same step every 25 ms forever. One step object in a link, and the
  instrument is dead until reload.
- Chain `steps`, decompressed byte counts, zip entry counts and param-key counts
  had no ceiling at all, so a link that fits in an address bar could expand to
  gigabytes or to millions of DOM nodes.

[ADR-015](../decisions/adr-015-untrusted-input-is-bounded.md) records the
decision and the alternatives. This spec is the contract.

## Requirements

- **REQ-1 — The surfaces are enumerated.** The trust boundary is: `#song=`,
  `#songUrl=`, the file input (`.json` / `.zip`), the PWA `launchQueue`, paste,
  demo fetches, the WebRTC data channel, a scanned QR blob, rehydration from
  `localStorage` / IndexedDB, and MCP tool arguments. Anything reading one of
  these obeys REQ-2..REQ-8. A new ingest surface owes an entry here.

- **REQ-2 — Bounds live in the validator, sizes live in the codec.** Ranges are
  checked by `song-validate.ts` / `song-author.ts` / `preset-validate.ts`,
  because [ADR-004](../decisions/adr-004-patternstore-separate-from-parambus.md)
  guarantees `PatternStore` will not re-check them. Byte budgets are enforced by
  `compression.ts` / `zip.ts` **while decoding**, never by measuring the result —
  a cap applied after the fact has already spent the memory.

- **REQ-3 — The limits are one module.** `src/state/limits.ts` exports the table
  below and nothing else. Every consumer imports from it; no literal duplicates.

- **REQ-4 — Bounded values.** `SeqStep.note` is an integer `0..127` in **both**
  the canonical validator and the dialect (the dialect already enforced this; the
  canonical format was the looser of the two). Chain `steps` is `1..MAX_CHAIN_STEPS`.
  `params` carries at most `MAX_PARAM_KEYS` keys. Existing checks are unchanged:
  `Number.isFinite` on every number, exact grid dimensions, `KNOWN_SONG_VERSIONS`.

- **REQ-5 — Reserved keys are refused.** An object arriving from a payload may
  not carry `__proto__`, `constructor` or `prototype`. `PatternStore.restore`
  does `Object.assign(cell, DEFAULTS, parsedCell)`, which invokes the `__proto__`
  setter; today every read field is an own property so the effect is inert, but
  that is a coincidence of the defaults covering every field, not a guarantee.
  Refusing the key at the boundary is what makes it a guarantee.

- **REQ-6 — No subscriber can wedge the clock.** `Clock.tick` isolates each
  listener and advances `nextStepTime` / `_step` **regardless of a throw**, so a
  failing lane can never stop the transport or the other lanes. A caught error is
  reported once per listener (not once per tick — a wedged listener would
  otherwise flood the console at 40 Hz). `Clock.setBpm` and
  `Oscillator.setFrequency` reject non-finite input, because the app-wide
  `Math.max(min, Math.min(max, v))` clamp idiom returns `NaN` for `NaN`.

- **REQ-7 — A link may not fetch silently.** `#song=` carries its own payload —
  no network, no third party — so it keeps applying at boot unprompted.
  `#songUrl=` is **`https:` only** (not `https?:`) and requires **consent**: a
  `confirmDialog` naming the target **origin** before any request. The fetch is
  `credentials: 'omit'`, `redirect: 'error'`, `mode: 'cors'`, with a timeout, and
  a `Content-Length` over `MAX_SONG_JSON_BYTES` is refused before buffering.
  Failures use the shared `alertDialog`, never the native `alert()`.

- **REQ-8 — Deserialized state is validated, never cast.** Anything reaching
  `JSON.parse` is passed through a type guard or a validator before use —
  including the WebRTC wire (`as Wire` is not a check) and rehydration from
  storage. The model is `SessionAutosave.load()`: validate, and **clear the key**
  on failure so a poisoned value cannot wedge every subsequent boot.

- **REQ-9 — An import may not silently destroy saved work.** A song whose name
  collides with an existing `localStorage` slot must be confirmed before it
  overwrites — the load-undo toast restores the *session*, not the persisted
  slot, so an unconfirmed overwrite is unrecoverable. This mirrors
  [presets](presets.md) REQ-10 ("never a blind merge") and
  [ADR-014](../decisions/adr-014-dont-make-me-think.md). **Destroy** is the
  operative word (v2): a slot already holding byte-identical bytes loses nothing,
  so re-importing the same link twice does not prompt — a guard that cries wolf
  is a guard the user learns to click through.
  [session-autosave](session-autosave.md) REQ-14/14b owns the mechanism.

- **REQ-10 — Defence in depth at the delivery layer.** `index.html` carries a
  CSP `<meta>`, and `public/_headers` carries the frame/sniffing/referrer headers
  that a `<meta>` **cannot** express (`frame-ancestors` is ignored in `<meta>`).
  There is no XSS to fix today; this keeps the six runtime-computed `innerHTML`
  sites from becoming one after a careless refactor.

- **REQ-11 — MCP writes stay inside the working directory.** `save_song` /
  `save_preset` sanitize the *filename* (`safeName`) **and** contain the `dir`
  argument: a path resolving outside `cwd` is refused. The caller is an agent,
  and an agent reading a hostile song file is a prompt-injection path to an
  arbitrary file write.

- **REQ-12 — An unresolvable automation target warns; it never rejects, and it
  never passes unremarked.** `xy.x` / `xy.y`, `motionAssigns[i].x` / `.y` and
  `motionTracks[b][t].param` each name a `ParamBus` id. Three facts collide here:

  1. `MotionMachine.write` does `const def = this.bus.def(id); if (!def) return;`
     — an id this build does not register is a **silent** no-op, so one typo
     (`filter.cuttoff`) costs an entire automation lane with no feedback at
     author time, at import, or in the UI.
  2. Rejecting the song is not available:
     [ADR-007](../decisions/adr-007-songfile-additive-versioning.md) promises a
     song from a *newer* build keeps loading, and a target naming a parameter
     added after this build shipped is exactly that case. Refusing it would
     orphan forward-authored songs — the failure ADR-007 exists to prevent.
  3. Unlike the `params` map, an automation target is a **pointer, not a value**.
     An unknown param key is preserved verbatim and costs nothing; an unknown
     pointer resolves to nothing and the lane is dead.

  So `validateSongFile` returns `warnings: string[]` alongside `ok: true`, one
  per unresolvable target, named by path
  (`motionTracks[0][1].param: unknown parameter "not.a.param"`). The song loads
  unchanged — behaviour is byte-for-byte what it was — but every authoring
  surface can now say what will not move. `warnings` is **advisory and
  order-independent**; a consumer that ignores it behaves exactly as before.

  Consumers: `validate_song` / `expand_song` report warnings in their payload
  ([mcp-server](mcp-server.md) REQ-13), and the app's import surfaces show them
  as a non-blocking toast — never a dialog, because the song did load and
  interrupting a successful import to report a lane that will not sweep is the
  guard-crying-wolf failure REQ-9 already warns about.

## Technical design

### Contract / public interface

```ts
// src/state/limits.ts — the single source of truth (REQ-3)
export const MAX_SONG_JSON_BYTES: number;   // decodeSongPayload + fetched songUrl body
export const MAX_ZIP_ENTRY_BYTES: number;   // one zipRead entry
export const MAX_ZIP_TOTAL_BYTES: number;   // summed across entries
export const MAX_ZIP_ENTRIES: number;       // central-directory count
export const MAX_SIGNAL_BYTES: number;      // decodeSignal (WebRTC / QR)
export const MAX_CHAIN_STEPS: number;       // arrangement chain length
export const MAX_CHAIN_DEPTH: number;       // expandChain recursion
export const MAX_PARAM_KEYS: number;        // params map size
export const MIDI_NOTE_MIN = 0;
export const MIDI_NOTE_MAX = 127;
export const RESERVED_KEYS: readonly string[]; // __proto__, constructor, prototype

// src/utils/compression.ts
export function inflateRaw(bytes: Uint8Array, maxBytes?: number): Promise<Uint8Array>;
// throws when the *running* output total exceeds maxBytes; cancels the reader

// src/utils/zip.ts — unchanged signature; caps applied internally
export function zipRead(bytes: Uint8Array): Promise<ZipEntry[]>;  // throws ZipError

// src/state/song-validate.ts — REQ-12: warnings ride the success branch, so
// every existing caller keeps compiling and keeps behaving identically.
export type SongValidation =
  | { ok: true; file: SongFile; warnings?: string[] }
  | { ok: false; errors: string[] };

// src/state/params.ts — the id set, without standing up an Engine. Built once,
// lazily: the validator is on the boot path via the share-link and session
// restore, and runtime-performance.md REQ-1 counts module-init work.
export function paramIds(): ReadonlySet<string>;
```

### Data shapes (the limits)

```yaml
# Sized against the demo corpus plus generous headroom (ADR-015): raising a
# limit later is additive and safe; lowering one is a breaking change.
MAX_SONG_JSON_BYTES:  8388608     # 8 MB   — the largest demo is ~2 orders below
MAX_ZIP_ENTRY_BYTES:  67108864    # 64 MB  — one sampler clip (multi-MB WAVs)
MAX_ZIP_TOTAL_BYTES:  268435456   # 256 MB — 8 slots of clip audio + headroom
MAX_ZIP_ENTRIES:      64          # 8 clips + song.json + folder entries
MAX_SIGNAL_BYTES:     262144      # 256 KB — an SDP blob is ~700 bytes
MAX_CHAIN_STEPS:      1024        # 1024 bars is ~34 min at 120 BPM
MAX_CHAIN_DEPTH:      8           # {enabled,steps:{...}} nesting
MAX_PARAM_KEYS:       512         # the bus registers ~150
```

### Layer touchpoints & ordering

```yaml
share link (data):  parseSongLink -> decodeSongPayload(payload)         # capped inflate
                    -> Song.parse -> validate -> importSongBytes
share link (url):   parseSongLink (https only) -> confirmDialog(origin)  # REQ-7
                    -> fetch(credentials:omit, redirect:error, timeout)
                    -> Content-Length check -> importSongBytes
zip:                sniffImportKind -> zipRead (count/entry/total caps)
                    -> parseProjectZip -> Song.parse
clock:              tick() -> per-listener try/catch -> advance step ALWAYS  # REQ-6
webrtc:             onmessage -> isWireMessage(guard) -> emit   # REQ-8, drops silently
mcp:                save_* -> containedDir(dir) + safeName(name) # REQ-11
```

The error paths are the **existing** typed ones — `ZipError`,
`SignalDecodeError`, and the validator's `errors: string[]` — so a breach
surfaces through the import-error dialog the user already knows. No new *error*
channel is introduced.

REQ-12's `warnings` is deliberately **not** an error path: it rides the `ok: true`
branch, nothing rejects on it, and it is the only thing the validator reports
that is not a refusal. Earlier versions of this spec said "no new error channel
is introduced" full stop; that still holds for refusals, and the distinction is
the point — a warning must never acquire the power to stop an import, or it has
quietly become an error and taken ADR-007's forward-compatibility with it.

### Persistence

Nothing new persists. REQ-8's validate-or-clear affects how existing keys are
*read* (`websynth.session`, the song slot index, preset snapshots); REQ-9 gates
when a song slot is *written*.

## Scenarios (BDD)

```gherkin
Scenario: An out-of-range note is refused instead of wedging the transport
  Given a song whose seqBanks contain a step with note 1e6
  When it is imported
  Then validation fails naming the note field and its 0..127 range
  And the transport is untouched
# pinned by: tests/state/song-validate.test.ts

Scenario: A throwing listener cannot stop the clock (regression)
  Given a playing clock with a subscriber that throws on every tick
  When the clock ticks
  Then the step counter still advances
  And the other subscribers still receive their ticks
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A non-finite BPM leaves the tempo unchanged (edge)
  Given a clock at 120 BPM
  When setBpm(NaN) is called
  Then the tempo is still 120
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A deflate bomb is refused mid-stream, not after
  Given a share payload that inflates past MAX_SONG_JSON_BYTES
  When decodeSongPayload runs
  Then it throws before the full output is materialized
# pinned by: tests/state/song-link.node.test.ts

Scenario: An oversized or over-count zip is refused
  Given a zip whose entry inflates past MAX_ZIP_ENTRY_BYTES
  When zipRead runs
  Then it throws ZipError
  And a central directory declaring more than MAX_ZIP_ENTRIES is refused the same way
# pinned by: tests/utils/zip.test.ts

Scenario: An oversized chain is refused
  Given a song whose seqChain has more than MAX_CHAIN_STEPS steps
  When it is imported
  Then validation fails naming the chain and its limit
  And a deeply nested {steps:{steps:…}} fails validation instead of throwing
# pinned by: tests/state/song-validate.test.ts, tests/state/song-author.test.ts

Scenario: A reserved key is refused
  Given a song whose step cell carries a __proto__ key
  When it is imported
  Then validation fails naming the key
# pinned by: tests/state/song-validate.test.ts

Scenario: songUrl requires https and consent
  Given a #songUrl= link pointing at an http:// address
  Then parseSongLink returns null
  And an https:// link prompts with the target origin before any request is made
# pinned by: tests/state/song-link.test.ts, e2e/song-link.spec.ts

Scenario: An embedded #song= link still loads unprompted (regression)
  Given a valid #song= payload
  When the app boots
  Then the song applies with no dialog and the hash is cleared
# pinned by: e2e/song-link.spec.ts

Scenario: A malformed wire message is dropped, not applied
  Given a linked WebRtcSyncTransport
  When a peer sends {t:'tempo', bpm:'fast'} or {t:'tempo'} with no bpm
  Then the message is ignored and the tempo is unchanged
# pinned by: tests/audio/webrtc-sync-transport.test.ts

Scenario: Re-importing an identical song does not prompt (v2, REQ-9, regression)
  Given a slot holding exactly the song a share link carries
  When that link is opened again
  Then no overwrite prompt appears — the write would change nothing
  And a link carrying a *different* song under that name still prompts

Scenario: An MCP save cannot escape the working directory
  Given save_song called with dir '../..' or an absolute path
  Then it throws without writing
  And dir 'sub/dir' still writes normally
# pinned by: tests/mcp/tools.test.ts

Scenario: A misspelled automation target is reported, not swallowed (v3, REQ-12)
  Given a song with xy.x "filter.cuttoff" and motionTracks[0][0].param "not.a.param"
  When it is validated
  Then ok is true and the song is unchanged
  And warnings names both paths and both offending ids
# pinned by: tests/state/song-validate.test.ts

Scenario: A forward-authored target still loads (v3, REQ-12, ADR-007)
  Given a song whose motion track targets a parameter this build does not register
  When it is imported
  Then the import succeeds and every other lane behaves normally
  And the unknown target is reported as a warning, never as an error
# pinned by: tests/state/song-validate.test.ts

Scenario: Every shipped demo validates without warnings (v3, REQ-12)
  Given each song in src/state/demos and each built-in DEMO_SONGS literal
  When it is validated
  Then ok is true and warnings is empty
  # a warning here means a real demo has a dead automation lane
# pinned by: tests/state/song-validate.test.ts
```

## Tests & verification

- Unit: the files named in the scenarios above — `npm test`
- E2E: `e2e/song-link.spec.ts` (consent prompt on `#songUrl=`; `#song=` still
  silent) — `npm run e2e`
- Typecheck: `npm run typecheck`
- **Regression corpus:** every existing demo, share link and project zip must
  still load — the limits are the risk. `npm run check:demos`, then load each
  demo from the Song panel.
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)): the
  clock guard, `setBpm` and the oscillator finite-check all sit on the timing
  path. Play a demo and A/B against a pre-change build —
  `specs/recipes/verify-audio-by-ear.md`.

## Open questions / future

- **`#songUrl=` allow-list.** Consent covers the drive-by; a remembered
  per-origin allow-list would remove the prompt for a host the user trusts.
- **Streaming the fetched body** so an over-cap response is abandoned mid-flight
  rather than relying on `Content-Length` (which a hostile server may omit).
- **The SDP from a scanned QR** reaches `setRemoteDescription` unvalidated. The
  envelope is checked; the SDP body is handed to the browser's own parser, which
  is the hardened thing here — but a shape check would still be cheap.
- **Dropping `style-src 'unsafe-inline'`** once the `<noscript>` block's inline
  `style=` attributes move to a class.
