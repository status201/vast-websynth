# WebRTC WiFi sync (serverless DataChannel transport)

```yaml
id: webrtc-sync
status: implemented
version: 9
owner: core
related:
  - midi-clock-sync
  - architecture
  - performance
  - onboarding
  - untrusted-input
  - transport
  - meter
  - lazy-load-failure
  - typography          # the wizard's type follows the app-wide rule
source:
  - src/audio/transport/sync/sync-types.ts
  - src/audio/transport/sync/clock-offset.ts
  - src/audio/transport/sync/wifi-sync.ts            # WifiSyncTransport, the boot-time facade; WifiLink
  - src/audio/transport/sync/webrtc-sync-transport.ts
  - src/audio/transport/sync/webrtc-signaling.ts
  - src/utils/compression.ts             # shared deflate-raw helpers (also used by the zip codec)
  - src/audio/transport/sync/webrtc-diagnostics.ts
  - src/audio/transport/sync/sync-controller.ts
  - src/audio/engine.ts
  - src/ui/clipboard.ts
  - src/ui/components/sync-pair-modal.ts
  - src/ui/components/sync-section.ts
  - src/ui/panels/song-panel.ts
  - src/vendor/qr/index.ts
  - src/vendor/jsqr/index.ts
```

## Background / Why

[MIDI clock sync](midi-clock-sync.md) locks two instances over a transport-agnostic
`SyncTransport`. This is the second transport: a **WebRTC DataChannel** that pairs two
instances **on the LAN, with no signaling server and no npm dependencies**. Two people
on one WiFi swap a copy-pasteable code or scan a QR, and one then drives the other's
transport exactly as MIDI does. The sync core is untouched. The new machinery is an
NTP-style **clock-offset estimator** (peers do not share a clock) and the
**serverless pairing** UI. **LAN-only, empty `iceServers`** is deliberate: no STUN,
no TURN, offline-capable, and no NAT traversal (the help topic says "same network,
client isolation off"). It carries transport only; MIDI and WiFi coexist, the master
broadcasts to both, and a slave follows whichever delivers.

## Requirements

- **REQ-the-transport-opens-two-channels** — `WebRtcSyncTransport implements
  SyncTransport`, with **two negotiated DataChannels** on one `RTCPeerConnection`:
  `sync-control` (id 0, ordered + reliable) for `start`/`continue`/`stop`/
  `songposition`/`tempo`/`meter`, where loss or reorder is a bug; and `sync-timing`
  (id 1, `{ordered:false, maxRetransmits:0}`) for `pulse`/`ping`/`pong`, where a late
  retransmit is worse than a drop and head-of-line blocking at 96 msg/s must be
  avoided. `negotiated: true` with explicit ids, and **each peer creates its own**
  (`createChannels(pc)` from `createLink()` / `acceptOffer()`). Messages are JSON, one
  object each, and **every inbound message is type-guarded, never cast**: `t` must be
  a known variant and every numeric field `Number.isFinite`, or the message is
  **dropped silently**. A paired peer is semi-trusted, and a `{t:'tempo', bpm:'fast'}`
  must never reach `Clock.setBpm` ([transport](transport.md)
  REQ-bpm-and-swing-are-live-settable, [untrusted-input](untrusted-input.md)
  REQ-deserialized-state-is-validated-never-cast).
- **REQ-wire-timestamps-are-the-senders** — Every timestamp on the wire is the
  **sender's** `performance.now()`. The receiver converts `at` with
  `ClockOffsetEstimator.toLocal(at)` **before** `onMessage`, so `SyncSlave`'s math is
  identical to the MIDI path. A cold estimator (or a message without `at`) falls back
  to local receipt time.
- **REQ-a-join-carries-its-time** — `start` and `continue` carry the time they take
  effect (`{t:'continue', at}`), since a DataChannel sends at once while Web MIDI
  honours the schedule itself ([midi-clock-sync](midi-clock-sync.md)
  REQ-a-join-is-timed-by-its-first-pulse). The channels are separate, so the first
  pulse can overtake the join, and the time makes that harmless. `at` is **optional**
  both ways (an older peer neither sends nor reads it). A receiver with no offset
  estimate passes none. A present `at` must be finite or the message is dropped. The
  slave bounds it (`MAX_SYNC_JOIN_LEAD_MS`).
- **REQ-offset-estimation-is-pure** — `ClockOffsetEstimator` is pure. For a `{a, b,
  now}` sample: `rtt = now − a`, `offset = b − (a + rtt/2)`. It keeps 16 samples and
  accepts one into an EMA (α 0.25) **only** when `rtt ≤ 1.5 × min(rtt)`. The transport
  owns cadence: a burst of **8 pings at 150 ms** on open, then **1 Hz** (a `TickTimer`)
  to track drift. Both peers ping, and a `ping` is always answered.
- **REQ-the-sync-controller-is-multi-transport** — `SyncController.addTransport(id,
  t)` over a `Map` (`'midi' | 'wifi'`, same id replaces). Broadcasts go to every
  transport, and incoming messages from any are gated by mode. `SyncStatus.links` is
  `{id, ins, outs}[]`. When one transport's `outs` goes 0 → >0 while master, the
  announce targets **only that transport** ([midi-clock-sync](midi-clock-sync.md)
  REQ-midi-and-wifi-coexist).
- **REQ-the-wifi-transport-loads-at-pairing** — The Engine registers `'wifi'` at boot
  as `WifiSyncTransport` (`wifi-sync.ts`), a **synchronous facade over a lazy body**
  ([runtime-performance](runtime-performance.md) REQ-boot-cost-matches-the-request).
  `WebRtcSyncTransport`, the estimator and the codec stay out of the entry chunk.
  - Until the body exists the facade is unlinked: `send` drops, `ports()` is `{ ins:
    0, outs: 0 }`, `linked` is false and `diagnostics` empty.
  - The facade holds the listeners (`onMessage`, `onPortsChange`, `onDiagnostics`) and
    relays them once the body exists.
  - `createLink`, `acceptOffer` and `acceptAnswer` import and build the body on first
    call, then delegate. `closeLink` is a no-op without it.
  - A failed import rejects that call; the modal reports the failed step
    (operation-scoped, [lazy-load-failure](lazy-load-failure.md)
    REQ-lazy-scope-is-surfaces-not-operations), and the next step retries.

  The body is idle-warmed at boot (`main.ts` `warmDeferred`), since pairing works
  offline. UI and Engine hold the transport as `WifiLink`, which both classes
  implement.
- **REQ-pairing-is-serverless-and-non-trickle** — ICE is gathered to completion
  (`icegatheringstate === 'complete'`, 3 s timeout fallback), and the full SDP is
  encoded into a `WS2.` blob (`webrtc-signaling.ts`). `openSyncPairModal(rtc, sync)`
  (on `Modal`; `sync` is `Pick<SyncController, 'setMode'>`) is a **linear wizard, one
  step at a time**:
  - **Choose**: **Create Link** (`sync-pair-create`) or **Join a Link**
    (`sync-pair-join`). The role **sets the mode**: Create → `setMode('master')`, Join →
    `setMode('slave')`;
  - **Create**: show the offer (QR + Copy + a half-height readonly text fallback),
    **Next** (`sync-pair-next`, disabled until resolved), then scan/paste the answer
    and **Complete link** (`sync-pair-apply`);
  - **Join**: scan/paste the offer, **Generate reply** (`sync-pair-generate`), then
    show the answer with a "waiting to connect" status;
  - every step has **Back** (`sync-pair-back`) and a persistent, fully styled **Close**
    (`sync-pair-close`). On link it shows "Linked ✓" and self-closes;
  - type follows [typography](typography.md): title and step headings serif, the rest
    sans. Body copy must not reuse `Modal.tagClass`.

  QR **display** uses the vendored encoder. **Scan** is offered on any device with a
  camera: `BarcodeDetector` where present, else the vendored **jsQR** over canvas
  frames (Windows desktop, iOS Safari), so the return leg is symmetric. **The QR must
  stay camera-scannable**: a full SDP blob is a dense code (≈ 700 chars deflated →
  version 18, 89×89; more interfaces → v24+). It is drawn **one device-pixel per
  module** plus a 4-module quiet zone, then **upscaled** with `image-rendering:
  pixelated`. It is never CSS-clamped down, which drops modules. Testids:
  `sync-wifi-link`,
  `sync-pair-create/join/offer/answer/qr/status/scan/apply/generate/next/back/close`.
- **REQ-a-closed-channel-ends-the-session** — A DataChannel close, or
  `connectionstatechange ∈ {failed, closed}`, tears the link down **immediately**.
  `disconnected` is recoverable per spec, so it starts a grace timer
  (`DISCONNECT_GRACE_MS`), and a return to `connected` cancels it. On teardown
  `ports()` is 0/0, `onPortsChange` fires ("WiFi: not linked"), a playing slave
  free-runs ([midi-clock-sync](midi-clock-sync.md)
  REQ-a-stalled-pulse-stream-is-tolerated), and the zeroed ports release the role
  (REQ-selected-mode-versus-active-role/REQ-link-liveness-beats-port-presence), so the
  BPM knob returns. Re-pairing closes the previous peer first. A reload never resumes
  a link; the mode persists, the link does not.
- **REQ-sync-has-zero-npm-dependencies** — The QR encoder is vendored in
  `src/vendor/qr/` (MIT; vendored `.js` + used-subset `.d.ts` + `index.ts` +
  `LICENSE`). The decoder is in `src/vendor/jsqr/` (jsQR, **Apache-2.0**, jsqr@1.4.0
  `dist/jsQR.js` with its UMD wrapper replaced by an ESM `export default`; `NOTICE`
  kept). `src/vendor/**` is SDD-exempt. The peer connection has **empty
  `iceServers`**: LAN-only, an accepted trade-off that fails where mDNS/host
  candidates are blocked or AP isolation is on.
- **REQ-pairing-needs-a-secure-context** — WebRTC, `navigator.clipboard` and the camera
  need a secure origin. When `window.isSecureContext` is false the modal shows a
  **non-blocking** banner (`sync-pair-insecure`) asking for `https://` on both devices,
  and the copy-paste flow still renders.
- **REQ-a-failed-scan-leaves-the-camera-off** — The scan obtains its decoder
  (`BarcodeDetector`, or the lazy jsQR chunk) **before** asking for the camera, so a
  decoder that fails to load never starts a stream. Any later failure stops every
  track and removes the `<video>`. The error says what went wrong: a decoder failure
  in lazy-load wording ([lazy-load-failure](lazy-load-failure.md)), and only a
  refused/missing camera as "Camera unavailable". Both end with the paste fallback.
- **REQ-pairing-gives-connection-feedback** — After a peer completes its half the modal
  shows **"Connecting…"**. If the channels open it says "Linked ✓" and closes. If the
  link tears down or a watchdog elapses, `sync-pair-error` shows **actionable**
  guidance in sentence case, most common first: a firewall blocking the browser
  (Windows Defender — allow it or set the network Private), a VPN or virtual adapter
  (WSL / Docker / Hyper-V / VirtualBox), and same-WiFi with client isolation off.
  Switching step or closing cancels the wait.
- **REQ-the-pair-modal-resists-dismissal** — It sets `dismissOnBackdrop: false` (a
  general `ModalOptions` flag, default `true`), so an outside click mid-scan cannot
  discard the handshake. Close and Escape still close.
- **REQ-every-sync-attempt-is-recorded** — A collapsible **debug panel**
  (`sync-pair-debug`) under the error shows a `WebRtcDiagnostics` snapshot
  (`diagnostics` + `onDiagnostics(cb)`), built from ICE events and `getStats`: ICE and
  connection state history, local candidates (type/protocol/address, which exposes
  virtual-adapter subnets), the remote-candidate count, the selected pair, and any
  `icecandidateerror`s. The pure `summarizeDiagnostics()` turns it into plain-language
  hints (several subnets → a VPN/virtual adapter; `checking` with no pair → a firewall
  or different subnets; zero remote candidates → redo the exchange). The parse and
  summarize logic lives in `webrtc-diagnostics.ts` (no DOM/RTC).
- **REQ-the-wire-carries-the-time-signature** — `{t:'meter', beats, unit}` on the
  control channel is announced by a master on link-up and on every local meter change
  ([meter](meter.md) REQ-meter-travels-on-the-wifi-wire). Otherwise peers resolve one
  Song Position into different bars. It is guarded like every variant, and applied
  through the `ParamBus`, so a followed meter shows in the picker and saves with the
  song.

## Technical design

### Contract / public interface

```yaml
# src/audio/transport/sync/sync-types.ts (shared with midi-clock-sync)
TransportId: "'midi' | 'wifi'"
SyncStatus.links: "Array<{ id: TransportId; ins: number; outs: number }>"

# src/audio/transport/sync/clock-offset.ts (pure)
ClockOffsetEstimator(opts?):
  addSample({a, b, now}): void      # a=local send, b=remote reply, now=local receive
  offsetMs: "number | null"         # EMA of accepted raw offsets; null until first accept
  toLocal(remoteAtMs): number       # remoteAtMs - offsetMs (identity when null)
  reset(): void

# src/audio/transport/sync/webrtc-signaling.ts (pure)
SignalKind: "'offer' | 'answer'"
encodeSignal(kind, sdp): Promise<string>   # -> "WS2.<c|r>.<base64url>"
decodeSignal(blob): Promise<{ kind, sdp }> # throws SignalDecodeError on bad input

# src/audio/transport/sync/wifi-sync.ts
WifiLink                                   # the surface both classes implement
WifiSyncTransport implements WifiLink      # the boot-time facade over the lazy body

# src/audio/transport/sync/webrtc-sync-transport.ts (lazy)
WebRtcSyncTransport(opts?: { rtc?; timer?; nowMs? }) implements WifiLink:
  send(msg, atMs?): void            # stamps sender time; routes by type; no-op unlinked
  onMessage(cb): unsubscribe        # receiver-domain timestamps (offset-converted)
  ports(): "{ ins: number; outs: number }"     # linked ? 1/1 : 0/0
  onPortsChange(cb): unsubscribe
  createLink(): Promise<string>     # host: returns offer blob (awaits ICE complete)
  acceptOffer(blob): Promise<string> # guest: returns answer blob
  acceptAnswer(blob): Promise<void> # host: completes the link
  closeLink(): void
  get linked(): boolean
  get diagnostics(): WebRtcDiagnostics
  onDiagnostics(cb): unsubscribe

# src/audio/transport/sync/webrtc-diagnostics.ts (pure — no DOM/RTC)
WebRtcDiagnostics: "{ iceHistory[], connHistory[], gathering, localCandidates: CandInfo[], remoteCandidateCount, selectedPair: {local,remote}|null, candidateErrors[] }"
CandInfo: "{ type, protocol, address }"
emptyDiagnostics(): WebRtcDiagnostics
parseCandidate(line): CandInfo | null      # parse an SDP a=candidate line
summarizeDiagnostics(d): string[]          # plain-language hints for the debug panel

# src/ui/clipboard.ts
copyText(text): Promise<boolean>
flashCopied(btn, original, done): void

# src/ui/components/sync-pair-modal.ts
openSyncPairModal(rtc: WifiLink, sync: Pick<SyncController, 'setMode'>): void
# src/ui/components/sync-section.ts
buildSyncSection(sync: SyncController, rtc: WifiLink): HTMLElement

# src/vendor/qr/index.ts
qrcode(typeNumber, ecLevel): { addData; make; getModuleCount; isDark }
# src/vendor/jsqr/index.ts
jsQR(data: Uint8ClampedArray, width, height, opts?): { data: string } | null
```

### Data shapes

```yaml
# JSON envelope on the wire (one object per message); at = sender performance.now() ms
control channel (sync-control): "{t:'start', at?} | {t:'continue', at?} | {t:'stop'} | {t:'songposition', beat} | {t:'tempo', bpm} | {t:'meter', beats, unit}"
timing channel (sync-timing):   "{t:'pulse', at} | {t:'ping', a} | {t:'pong', a, b}"

# Estimator tuning (clock-offset.ts)
sampleWindow: 16
emaAlpha: 0.25
rttGate: 1.5             # accept only when rtt <= rttGate * min(rtt in window)

# Transport tuning (webrtc-sync-transport.ts)
pingBurstCount: 8
pingBurstMs: 150
pingSteadyMs: 1000
iceCompleteTimeoutMs: 3000
disconnectGraceMs: 5000     # 'disconnected' recovery window before teardown

# Signal blob: "WS2." <codec> "." <base64url payload>
#   codec 'c' = CompressionStream('deflate-raw') (feature-detected); 'r' = raw UTF-8
```

### Layer touchpoints & ordering

- `Engine.init()` builds `this.rtcSync = new WifiSyncTransport()` right after
  `SyncController` and calls `this.sync.addTransport('wifi', this.rtcSync)`. No
  `RTCPeerConnection` exists until pairing. `rtcSync` is on `StudioApi` (the pair modal
  + the E2E bridge).
- `midi.ts` calls `engine.sync.addTransport('midi', sync)`.
- The Song panel's `buildSyncSection(engine.sync, engine.rtcSync)` adds **WiFi link…**
  (`sync-wifi-link`) and a WiFi status suffix. It `import()`s `sync-pair-modal.ts` on
  click (with the QR encoder), and the modal `import()`s `src/vendor/jsqr` only in its
  scan fallback.
- `ai-prompt.ts` shares `copyText`/`flashCopied` from `src/ui/clipboard.ts`.

### Persistence

Nothing new. The **mode** persists (`websynth.midisync`, midi-clock-sync). The **link**
is ephemeral: blobs, candidates and the peer connection are never stored.

## Visual aids

```
Host (Create)                         Guest (Join)
  createLink() ──offer blob──▶ (copy/paste or QR) ──▶ acceptOffer(blob)
  acceptAnswer(blob) ◀── (copy/paste or QR) ◀──answer blob── returns
        └── both DataChannels open → ports 1/1 → status "WiFi: linked" ──┘
```

Platform APIs (all built in): `RTCPeerConnection` / `RTCDataChannel` (`iceServers:
[]`), `CompressionStream('deflate-raw')`, `BarcodeDetector`, `getUserMedia` + canvas
`getImageData`. Vendored: `qrcode-generator` (Kazuhiko Arase, MIT) and `jsQR` (Cosmo
Wolfe, Apache-2.0).

## Scenarios (BDD)

```gherkin
Scenario: Signal blob round-trips through both codecs
  Given an SDP string
  When encodeSignal('offer', sdp) runs with CompressionStream available (codec 'c')
   And again with it absent (codec 'r' fallback)
  Then decodeSignal(blob) returns {kind:'offer', sdp} for both
   And a corrupt blob rejects with SignalDecodeError
# pinned by: tests/audio/transport/sync/webrtc-signaling.test.ts

Scenario: Offset estimator converges and gates high-RTT samples
  Given ping/pong samples with a stable true offset and one delayed (high-rtt) pong
  Then offsetMs converges near the true offset
   And the delayed sample is rejected by the 1.5x-min-rtt gate
   And toLocal(remoteAt) maps a remote timestamp into the local domain
# pinned by: tests/audio/transport/sync/clock-offset.test.ts

Scenario: Transport routes messages to the right channel and stamps time
  Given a linked WebRtcSyncTransport (fake RTC)
  When send({type:'stop'}) and send({type:'pulse'}, 42) are called
  Then 'stop' goes over sync-control and 'pulse' over sync-timing
   And each JSON carries the sender's performance.now() (pulse carries at)
# pinned by: tests/audio/transport/sync/webrtc-sync-transport.test.ts

Scenario: Receiver converts sender time before onMessage
  Given a warm offset estimator on the receiving transport
  When a pulse arrives with the sender's at
  Then onMessage is invoked with a receiver-domain timestamp (offset-applied)
   And with a cold estimator it falls back to local receipt time
# pinned by: tests/audio/transport/sync/webrtc-sync-transport.test.ts

Scenario: A malformed wire message is dropped, not applied
  Given a linked WebRtcSyncTransport
  When a peer sends {t:'tempo', bpm:'fast'}, {t:'tempo'} with no bpm,
    or an unknown {t:'???'}
  Then none of them reach onMessage and the tempo is unchanged
# pinned by: tests/audio/transport/sync/webrtc-sync-transport.test.ts

Scenario: Channel close degrades status; a playing slave keeps playing
  Given a linked slave following the master
  When the data channel closes (or connectionstate → failed)
  Then ports() reads 0/0 and onPortsChange fires ("WiFi: not linked")
   And the slave keeps playing at the last tempo (stall free-run)
# pinned by: tests/audio/transport/sync/webrtc-sync-transport.test.ts

Scenario: 'disconnected' gets a grace window before teardown (regression)
  Given a linked transport whose connectionState flaps to 'disconnected'
  When it returns to 'connected' within the grace window
  Then the link is NOT torn down (no onPortsChange to unlinked)
   And if it stays disconnected past the grace window, it tears down
# pinned by: tests/audio/transport/sync/webrtc-sync-transport.test.ts

Scenario: Diagnostics summarize a failing attempt into plain-language hints
  Given a WebRtcDiagnostics with local candidates on two different subnets
   And an ICE history that reached 'checking' but no selected pair
  Then summarizeDiagnostics names a likely VPN/virtual-adapter cause
   And names a firewall / different-subnet cause when checking never connects
   And parseCandidate extracts type/protocol/address from an a=candidate line
# pinned by: tests/audio/transport/sync/webrtc-diagnostics.test.ts

Scenario: The pair modal shows a debug panel from a diagnostics snapshot
  Given diagnostics with local candidate addresses and a summary
  When the debug panel renders them
  Then sync-pair-debug lists the candidate addresses and the hint text
# pinned by: tests/ui/sync-pair-modal.test.ts

Scenario: WiFi link opens mid-play → announce to the new link only
  Given a master playing with a MIDI slave already locked
  When a WiFi transport's outs go 0 → >0 (link opens)
  Then announceTo targets only the WiFi transport (tempo + songposition + continue)
   And the MIDI transport receives no new start/continue (no audible restart)
# pinned by: tests/audio/transport/sync/sync-controller.test.ts

Scenario: Pairing wizard steps and role→mode (jsdom)
  Given the sync-pair modal on a fake transport with a setMode spy
  Then it opens on the Choose step (Create + Join, no offer field yet)
   And clicking Create calls setMode('master') and reaches the offer QR + Copy
   And clicking Join calls setMode('slave') and shows the offer input + Generate
   And a full exchange drives the wizard to "Linked ✓" on onPortsChange
# pinned by: tests/ui/sync-pair-modal.test.ts

Scenario: An outside click does not dismiss the pair modal; Close/Escape do
  Given the pair modal is open (dismissOnBackdrop: false)
  When the backdrop is clicked
  Then the modal stays open
   And the Close button (or Escape) closes it
# pinned by: tests/ui/sync-pair-modal.test.ts, tests/ui/modal.test.ts

Scenario: QR is rendered upscaled (never downscaled) so it stays scannable (regression)
  Given a large SDP-sized blob rendered by renderQr onto a canvas
  Then the canvas bitmap is one device-pixel per module plus a 4-module quiet zone
   And the CSS display size is larger than the bitmap (upscaled) with pixelated rendering
   And the bitmap is never CSS-clamped down to a fixed 180 px
# pinned by: tests/ui/sync-pair-modal.test.ts

Scenario: A QR from the encoder round-trips through the vendored jsQR decoder
  Given a dense SDP-sized blob encoded to a QR by the vendored qrcode encoder
  When it is rasterized (1px/module + quiet zone, upscaled) and decoded by jsQR
  Then jsQR returns the exact original blob string
   And the Scan button is offered whenever a camera is present, with or without BarcodeDetector
# pinned by: tests/vendor/jsqr.test.ts, tests/ui/sync-pair-modal.test.ts

Scenario: A scan whose decoder fails to load never turns the camera on (regression, REQ-a-failed-scan-leaves-the-camera-off)
  Given a device without BarcodeDetector whose jsQR chunk import rejects
  When the user presses Scan QR
  Then getUserMedia is never called and no <video> is mounted
   And the error line names the decoder (offline vs failed download), not "Camera unavailable"
  Given the decoder loads but the camera is refused
  Then the error line reads "Camera unavailable — paste the code instead."
# pinned by: tests/ui/sync-pair-scan.test.ts

Scenario: A join's time crosses the wire in the receiver's domain (REQ-a-join-carries-its-time)
  Given a linked pair whose offset estimate says remote = local + 40 ms
  When the master sends continue scheduled at its 1000 ms
  Then the wire carries {t:'continue', at: 1000}
   And the receiver's core sees continue with at 960
   And with no offset estimate yet, or from an older peer, it sees continue with no at
   And a non-finite or non-numeric at drops the message
# pinned by: tests/audio/transport/sync/webrtc-sync-transport.test.ts

Scenario: Insecure origin shows a non-blocking HTTPS banner (edge)
  Given window.isSecureContext is false
  When the pair modal opens
  Then a sync-pair-insecure banner is shown
   And the Create/Join copy-paste flow still renders
# pinned by: tests/ui/sync-pair-modal.test.ts

Scenario: A link that never opens surfaces guidance instead of silence
  Given the guest generated its answer and is awaiting the link
  When the peer connection fails (or the watchdog elapses) without linking
  Then sync-pair-error shows readable, actionable guidance
   And it names the real causes (same Wi-Fi; a VPN / virtual adapter on a laptop)
# pinned by: tests/ui/sync-pair-modal.test.ts

Scenario: Two real pages link and follow (E2E loopback)
  Given two pages in one headless-Chromium context, roles set via UI
  When A's offer/answer are exchanged with B via the rtcSync bridge
  Then both status lines read "WiFi: linked"
   And Play on A starts B; a BPM change on A is followed by B; Stop on A stops B
# pinned by: e2e/webrtc-sync.spec.ts
```

## Tests & verification

- Unit: `tests/audio/transport/sync/{clock-offset,webrtc-signaling,webrtc-sync-transport,webrtc-diagnostics,sync-controller}.test.ts`
  (fake RTC in `tests/audio/fake-rtc.ts`), `tests/ui/sync-pair-modal.test.ts`,
  `tests/ui/sync-pair-scan.test.ts`, `tests/vendor/jsqr.test.ts` — `npm test`.
- E2E: `e2e/webrtc-sync.spec.ts` (a real two-page RTC loopback), `e2e/sync.spec.ts`.
- Manual: two `localhost` tabs pair on one machine. Cross-device needs HTTPS, and a
  QR scan needs a camera.

## Open questions / future

- **Configurable STUN**: one opt-in server would cross simple NATs, still with no TURN
  and no signaling server. Kept out for the offline, zero-config promise.
- **Note forwarding**: the `SyncMessage` union can grow note variants; the control
  channel is already reliable and ordered.
- **Pulse batching** is possible if a much higher pulse rate is ever needed.
