# WebRTC WiFi sync (serverless DataChannel transport)

```yaml
id: webrtc-sync
status: implemented
version: 5
owner: core
related:
  - midi-clock-sync
  - architecture
  - performance
  - onboarding
source:
  - src/audio/transport/sync/sync-types.ts
  - src/audio/transport/sync/clock-offset.ts
  - src/audio/webrtc-sync-transport.ts
  - src/audio/webrtc-signaling.ts
  - src/audio/webrtc-diagnostics.ts
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

MIDI clock sync (`midi-clock-sync.md`) locks two instances together over a
transport-agnostic `SyncTransport`. Web MIDI is the v1 transport (USB / hardware
gear). This spec adds the second transport promised in that spec's open
questions: a **WebRTC DataChannel** wire that pairs two instances **over the
LAN, with no signaling server and no npm dependencies**. Two people on the same
WiFi (a phone and a laptop, two phones) create/join a link by swapping a
copy-pasteable code — or scanning a QR — and thereafter one drives the other's
transport exactly as MIDI does.

The sync **core is untouched** by the new transport: `WebRtcSyncTransport`
implements the same `SyncTransport` interface, so `SyncMaster`/`SyncSlave`'s
timing math never learns it exists. The only genuinely new machinery is (a) a
pure NTP-style **clock-offset estimator** that converts the sender's
`performance.now()` timestamps into the receiver's domain (WebRTC peers do not
share a clock the way two ends of one MIDI cable effectively do), and (b) the
**serverless pairing** UI (offer/answer blob exchange + QR).

**LAN-only, empty `iceServers`** is a deliberate decision (see REQ-7): no STUN,
no TURN, fully offline-capable. It pairs two devices on the same network via
mDNS/host candidates; it does *not* traverse NAT to the public internet. The
help topic documents the "same network, client isolation off" requirement.

Scope: transport-only, exactly like MIDI (no note forwarding — a v3 candidate).
MIDI and WiFi transports **coexist**: the master broadcasts to both, and a slave
follows whichever delivers.

## Requirements

- **REQ-1** — `WebRtcSyncTransport implements SyncTransport`. It opens **two
  negotiated DataChannels** on one `RTCPeerConnection`: `sync-control` (id 0,
  ordered + reliable) carries semantic state (`start`/`continue`/`stop`/
  `songposition`/`tempo`) where loss or reorder is a correctness bug;
  `sync-timing` (id 1, `{ordered:false, maxRetransmits:0}`) carries `pulse`/
  `ping`/`pong` where a *late-retransmitted* pulse is worse than a dropped one
  (a 24-interval estimator window + 1 s stall tolerance absorb loss) and
  head-of-line blocking of 96 msg/s pulses must be avoided. Both channels are
  created by the **offerer** with `negotiated: true` + explicit ids so both
  peers construct symmetric channels without an `ondatachannel` handshake.
  Messages are JSON, one object per message.
- **REQ-2** — All timestamps on the wire are the **sender's**
  `performance.now()`. The receiver converts a message's `at` to its own domain
  via `ClockOffsetEstimator.toLocal(at)` **before** invoking the `onMessage`
  callback, so `SyncSlave` receives receiver-domain timestamps and its timing
  math is byte-for-byte identical to the MIDI path. Before the offset is warm
  (or a message carries no `at`), the transport falls back to local receipt
  time (`performance.now()`).
- **REQ-3** — Offset estimation is a pure `ClockOffsetEstimator` (no clocks, no
  `performance`, no RTC). NTP-style: for a `{a, b, now}` sample (`a` = local
  send time of the ping, `b` = remote receive/reply time echoed in the pong,
  `now` = local receive time of the pong), `rtt = now − a`, raw
  `offset = b − (a + rtt/2)`. Keep the last 16 samples; accept a sample into an
  EMA (α 0.25) **only** when `rtt ≤ 1.5 × min(rtt)` (lowest-RTT filtering
  rejects samples delayed by scheduling jitter). The transport owns cadence:
  a burst of **8 pings at 150 ms** on channel open, then **1 Hz** thereafter
  (a `TickTimer`); both peers ping, and a `ping` is answered with a `pong`
  unconditionally. 1 Hz keeps the EMA tracking cross-device `performance.now()`
  drift over long sessions.
- **REQ-4** — The controller is **multi-transport**:
  `SyncController.addTransport(id: TransportId, t)` manages a `Map`
  (`TransportId = 'midi' | 'wifi'`); adding the same id replaces + unsubscribes
  the old one. Broadcasting loops over **every** transport; incoming messages
  from **any** transport are gated by mode exactly as before. `attachTransport`
  (replace-single) is removed. `SyncStatus.ports` is replaced by
  `links: Array<{id, ins, outs}>`. When a transport's `outs` goes **0 → >0
  while master**, the controller calls `master.announceTo` targeting **only that
  transport's `send`** (a broadcast would audibly restart already-locked MIDI
  slaves — see midi-clock-sync REQ-10).
- **REQ-5** — Pairing is **non-trickle** and serverless. The transport gathers
  ICE to completion (`icegatheringstate === 'complete'`, 3 s timeout fallback)
  then encodes the full SDP into a `WS2.` blob (`webrtc-signaling.ts`). The
  `sync-pair-modal.ts` (built on `Modal`) is a **linear, foolproof wizard**
  — `openSyncPairModal(rtc, sync)`, where `sync` is a `Pick<SyncController,
  'setMode'>` — presenting **one step at a time**, never the whole exchange at
  once:
  - **Choose** — the entry step: two buttons, **Create Link** (`sync-pair-create`)
    and **Join a Link** (`sync-pair-join`). Choosing a role **also sets the
    transport mode** so the pairing UI and the Sync section's Off/Master/Slave
    control agree: Create → `sync.setMode('master')`, Join → `sync.setMode('slave')`.
  - **Create → Master** — *Step 1 of 2*: show the offer (QR + Copy + a
    half-height readonly text fallback), with a hint to Join+scan on the other
    device; **Next** (`sync-pair-next`, disabled until the offer resolves) →
    *Step 2 of 2*: scan/paste the answer, then **Complete link** (`sync-pair-apply`).
  - **Join → Slave** — *Step 1 of 2*: scan/paste the offer, then **Generate reply**
    (`sync-pair-generate`) → *Step 2 of 2*: show the answer (QR + Copy + half-height
    text) with a "waiting to connect" status.
  - Every step has **Back** (`sync-pair-back`) and a persistent **Close**
    (`sync-pair-close`); on link the body swaps to a "Linked ✓" success and
    self-closes. Textareas are **half** the shared modal height (QR + Copy are the
    primary transfer; the text blob is a fallback). Close is a **fully-styled
    button** (base button style + full-width layout — not a bare text label).
  - **Typography rule** (applies app-wide): only the modal **title**, step
    **headings/subtitles**, and **taglines** are serif (`--serif`); all
    body/intro/instruction text is **sans-serif** (`--sans`). Intro text carries a
    small top margin off its heading. (`Modal.tagClass` is serif, so body copy
    must not reuse it.)

  Copy-paste always works; QR **display** uses the vendored encoder; QR
  **scan** is offered on **any device with a camera** (`navigator.mediaDevices
  .getUserMedia`) — the decode uses the platform `BarcodeDetector` where present
  (fast path) and **falls back to the vendored jsQR decoder** (canvas
  `getImageData` frames) where it is absent (Windows desktop Chrome/Edge, iOS
  Safari). This makes the **return leg symmetric**: the host can scan the guest's
  answer QR even on a laptop, instead of hand-transferring the blob. Testids:
  `sync-wifi-link` (launch button),
  `sync-pair-create`/`sync-pair-join`/`sync-pair-offer`/`sync-pair-answer`/
  `sync-pair-qr`/`sync-pair-status`/`sync-pair-scan`/`sync-pair-apply`/
  `sync-pair-generate`/`sync-pair-next`/`sync-pair-back`/`sync-pair-close`.
  **QR rendering must stay camera-scannable**: a full non-trickle SDP blob is a
  dense code (a deflated offer ≈ 700 chars → QR **version 18, 89×89 modules**;
  more network interfaces push it to v24+, 113×113). It is drawn **one
  device-pixel per module** plus a 4-module quiet zone, then **upscaled** (never
  downscaled) with `image-rendering: pixelated` to a large, viewport-responsive
  display size, so the modules stay crisp with ≥ 3 px each. Drawing a big bitmap
  and CSS-clamping it *down* to a fixed 180 px (the v1 bug) left ~2 px/module and
  nearest-neighbour-dropped modules — undecodable by **any** reader.
- **REQ-6** — Lifecycle. A DataChannel close or a `connectionstatechange ∈
  {failed, closed}` tears the link down **immediately**. `disconnected` is
  **transient/recoverable** per the WebRTC spec, so it is **not** an immediate
  teardown: the transport starts a grace timer (`DISCONNECT_GRACE_MS`) and tears
  down only if the state is still `disconnected`/`failed` when it elapses;
  a recovery to `connected` cancels it. (Tearing down on `disconnected` — the v1
  behaviour — killed connections that were still completing their ICE checks or
  briefly flapping.) On teardown: `ports()` returns `{ins:0, outs:0}`,
  `onPortsChange` fires (status "WiFi: not linked"), and a **playing slave keeps
  playing** via the existing > 1 s stall free-run (midi-clock-sync REQ-6).
  Re-pairing closes the previous peer first. A page reload **never** resumes a
  link (the sync *mode* persists; the link does not) — the user re-pairs.
- **REQ-8** — **Secure-context notice.** WebRTC pairing, `navigator.clipboard`,
  and the QR camera all require a secure origin. When `window.isSecureContext`
  is false the modal shows a **non-blocking** banner (`sync-pair-insecure`)
  telling the user to open the app over `https://` on **both** devices; the
  copy-paste flows still render (best-effort) rather than the modal failing in
  silence. (Cross-device pairing over plain `http://<lan-ip>` is the common
  first-time trap — same constraint the mic modal already guards.)
- **REQ-9** — **Connection feedback.** After a peer completes its half — host
  accepts the guest's answer, or guest generates its answer — the modal enters a
  **"Connecting…"** state instead of sitting silently at "Not linked". If the
  DataChannels open, `onPortsChange` flips the status to "Linked ✓" and the modal
  self-closes; if the link tears down (`onPortsChange` fires with `linked`
  false — a `connectionstatechange ∈ {failed,closed}` or a channel close, or the
  `disconnected` grace period elapsing) **or** a watchdog elapses without a link,
  the modal surfaces **actionable** guidance on `sync-pair-error`, rendered
  **readably** (sentence case — not the uppercase/letter-spaced label style). The
  guidance names the real causes, most-common first: a **firewall** blocking the
  browser (Windows Defender Firewall — allow the browser / set the network to
  Private), a **VPN or virtual network adapter (WSL / Docker / Hyper-V /
  VirtualBox)**, and both devices on the same Wi-Fi with client/AP isolation off.
  Switching step or closing the modal cancels the wait.
- **REQ-11** — **Diagnostics panel.** Every connection attempt is recorded and
  surfaced in a collapsible **debug panel** (`sync-pair-debug`) under the error,
  so a failing pair can be self-diagnosed. The transport exposes a
  `WebRtcDiagnostics` snapshot (`diagnostics` getter + `onDiagnostics(cb)`),
  accumulated from the peer's ICE/candidate events and `getStats`:
  the **ICE + connection state history** (e.g. `checking → disconnected`), the
  **local ICE candidates** gathered (type/protocol/address — this is what exposes
  virtual-adapter subnets), the **remote-candidate count**, the **selected
  candidate pair** (or none), and any `icecandidateerror`s. A pure
  `summarizeDiagnostics()` turns the snapshot into plain-language **hints**
  (multiple adapter subnets → "a VPN/virtual adapter may be advertising
  unreachable addresses"; reached `checking` but no pair → "no path found — a
  firewall or different subnets"; zero remote candidates → "the other device's
  reply wasn't received — re-do the code exchange"). Pure parse/summarize logic
  lives in `src/audio/webrtc-diagnostics.ts` (no DOM/RTC) so it is unit-tested
  directly.
- **REQ-10** — **No accidental dismissal.** The pair modal is a multi-step flow, so
  it opts out of `Modal`'s backdrop-click close (`dismissOnBackdrop: false`) — an
  outside click while fiddling to scan a QR must not discard the in-progress
  handshake. It provides an explicit **Close** button (`sync-pair-close`); **Escape
  still closes** (owned by `Modal`). The opt-out is a general `ModalOptions` flag
  (default `true`, so every other dialog keeps backdrop-close).
- **REQ-7** — **Zero npm dependencies.** The QR encoder is vendored under
  `src/vendor/qr/` (MIT, `lamejs` layout: vendored `.js` + used-subset `.d.ts` +
  4-line `index.ts` + `LICENSE`; `src/vendor/**` is SDD-exempt). The QR **decoder**
  is vendored the same way under `src/vendor/jsqr/` (jsQR, **Apache-2.0**;
  jsqr@1.4.0 `dist/jsQR.js` with its webpack-UMD wrapper mechanically replaced by
  an ESM `export default`). Apache-2.0 is permissive and license-compatible with
  the MIT-vendored libs; its `NOTICE`/`LICENSE` are kept alongside. The
  `RTCPeerConnection` is created with **empty `iceServers`** — LAN-only, no STUN
  — an accepted trade-off: it is offline-capable and needs no third party, but
  fails where the network blocks mDNS/host candidates or enables AP client
  isolation. A configurable STUN server is a documented future option.

## Technical design

### Contract / public interface

```yaml
# src/audio/transport/sync/sync-types.ts (extended — see midi-clock-sync v2)
TransportId: "'midi' | 'wifi'"
SyncMessage: "... | {type:'tempo', bpm} | {type:'songposition', beat}"
SyncStatus.links: "Array<{ id: TransportId; ins: number; outs: number }>"  # replaces `ports`

# src/audio/transport/sync/clock-offset.ts (pure)
ClockOffsetEstimator(opts?):
  addSample({a, b, now}): void      # a=local send, b=remote reply, now=local receive
  offsetMs: "number | null"         # EMA of accepted raw offsets; null until first accept
  toLocal(remoteAtMs): number       # remoteAtMs - offsetMs (identity when null)
  reset(): void

# src/audio/webrtc-signaling.ts (pure)
SignalKind: "'offer' | 'answer'"
encodeSignal(kind, sdp): Promise<string>   # -> "WS2.<c|r>.<base64url>"
decodeSignal(blob): Promise<{ kind, sdp }> # throws SignalDecodeError on bad input

# src/audio/webrtc-sync-transport.ts
WebRtcSyncTransport(opts?: { rtc?; timer?; nowMs? }) implements SyncTransport:
  send(msg, atMs?): void            # stamps sender time; routes by type; no-op unlinked
  onMessage(cb): unsubscribe        # receiver-domain timestamps (offset-converted)
  ports(): "{ ins: number; outs: number }"     # linked ? 1/1 : 0/0
  onPortsChange(cb): unsubscribe
  createLink(): Promise<string>     # host: returns offer blob (awaits ICE complete)
  acceptOffer(blob): Promise<string> # guest: returns answer blob
  acceptAnswer(blob): Promise<void> # host: completes the link
  closeLink(): void
  get linked(): boolean
  get diagnostics(): WebRtcDiagnostics       # live snapshot of the current/last attempt
  onDiagnostics(cb): unsubscribe             # fires as the attempt progresses

# src/audio/webrtc-diagnostics.ts (pure — no DOM/RTC)
WebRtcDiagnostics: "{ iceHistory[], connHistory[], gathering, localCandidates: CandInfo[], remoteCandidateCount, selectedPair: {local,remote}|null, candidateErrors[] }"
CandInfo: "{ type, protocol, address }"
emptyDiagnostics(): WebRtcDiagnostics
parseCandidate(line): CandInfo | null      # parse an SDP a=candidate line
summarizeDiagnostics(d): string[]          # plain-language hints for the debug panel

# src/audio/transport/sync/sync-controller.ts (changed)
addTransport(id: TransportId, t: SyncTransport): void   # replaces attachTransport

# src/ui/clipboard.ts (extracted from ai-prompt.ts)
copyText(text): Promise<boolean>
flashCopied(btn, original, done): void

# src/ui/components/sync-pair-modal.ts
openSyncPairModal(rtc: WebRtcSyncTransport, sync: Pick<SyncController, 'setMode'>): void
#   wizard: Choose(role→setMode) → Master(show offer → get answer) | Slave(get offer → show answer) → Linked

# src/ui/components/sync-section.ts (changed)
buildSyncSection(sync: SyncController, rtc: WebRtcSyncTransport): HTMLElement

# src/vendor/qr/index.ts
qrcode(typeNumber, ecLevel): { addData; make; getModuleCount; isDark }

# src/vendor/jsqr/index.ts
jsQR(data: Uint8ClampedArray, width, height, opts?): { data: string } | null
```

### Data shapes

```yaml
# JSON envelope on the wire (one object per message); at = sender performance.now() ms
control channel (sync-control): "{t:'start'} | {t:'continue'} | {t:'stop'} | {t:'songposition', beat} | {t:'tempo', bpm}"
timing channel (sync-timing):   "{t:'pulse', at} | {t:'ping', a} | {t:'pong', a, b}"

# Estimator tuning (const block in clock-offset.ts)
sampleWindow: 16
emaAlpha: 0.25
rttGate: 1.5             # accept only when rtt <= rttGate * min(rtt in window)

# Transport tuning (const block in webrtc-sync-transport.ts)
pingBurstCount: 8
pingBurstMs: 150
pingSteadyMs: 1000
iceCompleteTimeoutMs: 3000
disconnectGraceMs: 5000     # 'disconnected' recovery window before teardown (REQ-6)

# Signal blob: "WS2." <codec> "." <base64url payload>
#   codec 'c' = CompressionStream('deflate-raw') available (feature-detected on globalThis)
#   codec 'r' = raw UTF-8 fallback; decode handles both
```

### Layer touchpoints & ordering

- `Engine.init()` constructs `this.rtcSync = new WebRtcSyncTransport()`
  immediately after `SyncController` and calls
  `this.sync.addTransport('wifi', this.rtcSync)`. No `RTCPeerConnection` objects
  exist until the user starts pairing. `rtcSync` is exposed on `StudioApi` as
  `readonly rtcSync` (drives the pair modal + the E2E bridge).
- `midi.ts` calls `engine.sync.addTransport('midi', sync)` (was
  `attachTransport`).
- The Song panel's `buildSyncSection(engine.sync, engine.rtcSync)` adds a
  **WiFi link…** button (`sync-wifi-link`) that opens `openSyncPairModal(rtc)`
  and a WiFi suffix on the status line. `sync-section.ts` **`import()`s**
  `sync-pair-modal.ts` lazily inside the button's click handler — pairing is a
  rarely-used flow, so the modal (and, transitively, the vendored QR *encoder*)
  is code-split out of the initial bundle. The modal in turn **`import()`s**
  `src/vendor/jsqr` only inside its scan fallback, so the ~large decoder is its
  own on-demand chunk fetched only when a device without `BarcodeDetector`
  actually scans. Neither dynamic import is on a critical path (a first open /
  first fallback-scan pays a one-time chunk fetch).
- `ai-prompt.ts` imports `copyText`/`flashCopied` from the new
  `src/ui/clipboard.ts` (pure DRY extraction — behaviour identical).

### Persistence

Nothing new persists. The sync **mode** persists (`websynth.midisync`, owned by
midi-clock-sync). The **link** is intentionally ephemeral: SDP blobs, ICE
candidates, and the live peer connection are never stored, so a reload always
starts unpaired.

## Visual aids

Pairing handshake (non-trickle, serverless):

```
Host (Create)                         Guest (Join)
  createLink() ──offer blob──▶ (copy/paste or QR) ──▶ acceptOffer(blob)
  acceptAnswer(blob) ◀── (copy/paste or QR) ◀──answer blob── returns
        └── both DataChannels open → ports 1/1 → status "WiFi: linked" ──┘
```

Libraries / platform APIs (all built-in, no npm):

- `RTCPeerConnection` / `RTCDataChannel` (WebRTC) — `iceServers: []`.
- `CompressionStream('deflate-raw')` where available (blob shrink; feature-detected).
- `BarcodeDetector` (QR scan, fast path) — feature-detected; absent → jsQR.
- `getUserMedia` + a `<canvas>` `getImageData` frame → the jsQR decoder is the
  scan path wherever `BarcodeDetector` is missing (Windows desktop, iOS Safari).
- Vendored `qrcode-generator` (Kazuhiko Arase, **MIT**), encoder-only, in
  `src/vendor/qr/`.
- Vendored `jsQR` (Cosmo Wolfe, **Apache-2.0**), decoder-only, in
  `src/vendor/jsqr/`.

## Scenarios (BDD)

```gherkin
Scenario: Signal blob round-trips through both codecs
  Given an SDP string
  When encodeSignal('offer', sdp) runs with CompressionStream available (codec 'c')
   And again with it absent (codec 'r' fallback)
  Then decodeSignal(blob) returns {kind:'offer', sdp} for both
   And a corrupt blob rejects with SignalDecodeError
# pinned by: tests/audio/webrtc-signaling.test.ts

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
# pinned by: tests/audio/webrtc-sync-transport.test.ts

Scenario: Receiver converts sender time before onMessage
  Given a warm offset estimator on the receiving transport
  When a pulse arrives with the sender's at
  Then onMessage is invoked with a receiver-domain timestamp (offset-applied)
   And with a cold estimator it falls back to local receipt time
# pinned by: tests/audio/webrtc-sync-transport.test.ts

Scenario: Channel close degrades status; a playing slave keeps playing
  Given a linked slave following the master
  When the data channel closes (or connectionstate → failed)
  Then ports() reads 0/0 and onPortsChange fires ("WiFi: not linked")
   And the slave keeps playing at the last tempo (stall free-run)
# pinned by: tests/audio/webrtc-sync-transport.test.ts

Scenario: 'disconnected' gets a grace window before teardown (regression)
  Given a linked transport whose connectionState flaps to 'disconnected'
  When it returns to 'connected' within the grace window
  Then the link is NOT torn down (no onPortsChange to unlinked)
   And if it stays disconnected past the grace window, it tears down
# pinned by: tests/audio/webrtc-sync-transport.test.ts

Scenario: Diagnostics summarize a failing attempt into plain-language hints
  Given a WebRtcDiagnostics with local candidates on two different subnets
   And an ICE history that reached 'checking' but no selected pair
  Then summarizeDiagnostics names a likely VPN/virtual-adapter cause
   And names a firewall / different-subnet cause when checking never connects
   And parseCandidate extracts type/protocol/address from an a=candidate line
# pinned by: tests/audio/webrtc-diagnostics.test.ts

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

- Unit: `tests/audio/transport/sync/clock-offset.test.ts`,
  `tests/audio/webrtc-signaling.test.ts`,
  `tests/audio/webrtc-sync-transport.test.ts` (fake RTC in
  `tests/audio/fake-rtc.ts`), `tests/audio/transport/sync/sync-controller.test.ts`
  (multi-transport + targeted announce), `tests/ui/sync-pair-modal.test.ts` —
  `npm test`
- E2E: `e2e/webrtc-sync.spec.ts` (real two-page RTC loopback),
  `e2e/sync.spec.ts` (WiFi status + link button present) — `npm run e2e`
- Typecheck: `npm run typecheck`
- Manual: two `localhost` tabs pair on one machine; cross-device WiFi needs
  HTTPS in production (WebRTC on a secure origin, same constraint as mic/MIDI);
  QR scan needs a camera + `BarcodeDetector` (Android Chrome).

## Open questions / future

- **Configurable STUN**: a single opt-in STUN server would let the link cross
  simple NATs (still no TURN, still no signaling server). Kept out of v2 to hold
  the offline-capable, zero-config promise.
- **Note forwarding (v3)**: the `SyncMessage` union can grow note-on/off
  variants; the control channel is already reliable+ordered for it.
- **Pulse batching**: JSON parse at ≤96 msg/s is negligible; batching several
  pulses per frame is possible if a very high pulse rate is ever needed.
