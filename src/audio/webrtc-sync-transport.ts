import type { SyncMessage, SyncTransport } from './transport/sync/sync-types';
import { type TickTimer, defaultTickTimer } from './transport/tick-timer';
import { ClockOffsetEstimator } from './transport/sync/clock-offset';
import { encodeSignal, decodeSignal } from './webrtc-signaling';
import { type WebRtcDiagnostics, type CandInfo, emptyDiagnostics, parseCandidate } from './webrtc-diagnostics';

/**
 * WebRTC DataChannel implementation of `SyncTransport` — the WiFi sibling of
 * `MidiSyncTransport` (webrtc-sync.md). Two instances pair over the LAN with no
 * signaling server (copy-paste / QR offer↔answer blobs) and thereafter carry
 * the same `SyncMessage`s the MIDI transport does.
 *
 * Two negotiated channels on one connection (webrtc-sync REQ-1):
 *  - `sync-control` (id 0, ordered+reliable): start/continue/stop/songposition/
 *    tempo — semantic state; loss or reorder would be a correctness bug.
 *  - `sync-timing` (id 1, unordered + `maxRetransmits:0`): pulse/ping/pong — a
 *    lost pulse is harmless, but a *late-retransmitted* one is poison, and 96
 *    msg/s pulses must not head-of-line-block.
 *
 * Timestamps on the wire are the **sender's** `performance.now()`; the receiver
 * converts a pulse's `at` into its own domain via `ClockOffsetEstimator` before
 * handing it to the sync core, so `SyncSlave`'s math is byte-for-byte identical
 * to the MIDI path (REQ-2). Ping/pong (both peers ping; pong replies always)
 * feed the estimator on a burst-then-1 Hz cadence (REQ-3).
 *
 * LAN-only: `iceServers: []` (no STUN) — offline-capable, no third party.
 */

const PING_BURST_COUNT = 8;
const PING_BURST_MS = 150;
const PING_STEADY_MS = 1000;
const ICE_TIMEOUT_MS = 3000;
const DISCONNECT_GRACE_MS = 5000; // 'disconnected' recovery window before teardown (REQ-6)
const STATS_POLL_MS = 800;        // diagnostics getStats cadence (REQ-11)

/** Wire envelope (keyed `t`) — kept distinct from the semantic `SyncMessage`. */
type Wire =
  | { t: 'start' } | { t: 'continue' } | { t: 'stop' }
  | { t: 'songposition'; beat: number } | { t: 'tempo'; bpm: number }
  | { t: 'meter'; beats: number; unit: number }
  | { t: 'pulse'; at: number }
  | { t: 'ping'; a: number } | { t: 'pong'; a: number; b: number };

export interface WebRtcSyncTransportOptions {
  /** RTCPeerConnection ctor (test double injected). */
  rtc?: typeof RTCPeerConnection;
  /** Ping-cadence timer (test double injected). */
  timer?: TickTimer;
  /** performance.now() (injectable for tests). */
  nowMs?: () => number;
}

export class WebRtcSyncTransport implements SyncTransport {
  private readonly RtcCtor: typeof RTCPeerConnection;
  private readonly timer: TickTimer;
  private readonly nowMs: () => number;
  private readonly offset = new ClockOffsetEstimator();

  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private timing: RTCDataChannel | null = null;
  private _linked = false;
  private pingCount = 0;

  private readonly messageListeners = new Set<(msg: SyncMessage, receivedAtMs: number) => void>();
  private readonly portListeners = new Set<() => void>();
  private readonly diagListeners = new Set<() => void>();
  private diag: WebRtcDiagnostics = emptyDiagnostics();
  private disconnectTimer = 0;
  private statsTimer = 0;

  constructor(opts?: WebRtcSyncTransportOptions) {
    this.RtcCtor = opts?.rtc ?? (globalThis as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection;
    this.timer = opts?.timer ?? defaultTickTimer();
    this.nowMs = opts?.nowMs ?? (() => performance.now());
  }

  // ---- SyncTransport ----

  send(msg: SyncMessage, atMs?: number): void {
    if (!this._linked) return; // no-op while unpaired
    switch (msg.type) {
      case 'pulse':
        this.sendTiming({ t: 'pulse', at: atMs ?? this.nowMs() });
        break;
      case 'start':
      case 'continue':
      case 'stop':
        this.sendControl({ t: msg.type });
        break;
      case 'songposition':
        this.sendControl({ t: 'songposition', beat: msg.beat });
        break;
      case 'meter':
        this.sendControl({ t: 'meter', beats: msg.beats, unit: msg.unit });
        break;
      case 'tempo':
        this.sendControl({ t: 'tempo', bpm: msg.bpm });
        break;
    }
  }

  onMessage(cb: (msg: SyncMessage, receivedAtMs: number) => void): () => void {
    this.messageListeners.add(cb);
    return () => { this.messageListeners.delete(cb); };
  }

  ports(): { ins: number; outs: number } {
    return this._linked ? { ins: 1, outs: 1 } : { ins: 0, outs: 0 };
  }

  onPortsChange(cb: () => void): () => void {
    this.portListeners.add(cb);
    return () => { this.portListeners.delete(cb); };
  }

  /** Live diagnostics for the current/last pairing attempt (REQ-11). */
  get diagnostics(): WebRtcDiagnostics {
    return this.diag;
  }

  onDiagnostics(cb: () => void): () => void {
    this.diagListeners.add(cb);
    return () => { this.diagListeners.delete(cb); };
  }

  get linked(): boolean {
    return this._linked;
  }

  // ---- Pairing (non-trickle: full SDP baked into the blob) ----

  /** Host: build the offer blob (awaits ICE gathering). */
  async createLink(): Promise<string> {
    this.closeLink();
    const pc = this.newConnection();
    this.createChannels(pc);
    await pc.setLocalDescription(await pc.createOffer());
    await this.waitIceComplete(pc);
    return encodeSignal('offer', pc.localDescription!.sdp);
  }

  /** Guest: consume the host's offer, return the answer blob. */
  async acceptOffer(blob: string): Promise<string> {
    const { kind, sdp } = await decodeSignal(blob);
    if (kind !== 'offer') throw new Error('Expected an offer link.');
    this.closeLink();
    const pc = this.newConnection();
    this.createChannels(pc);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await this.waitIceComplete(pc);
    return encodeSignal('answer', pc.localDescription!.sdp);
  }

  /** Host: complete the link with the guest's answer. */
  async acceptAnswer(blob: string): Promise<void> {
    const { kind, sdp } = await decodeSignal(blob);
    if (kind !== 'answer') throw new Error('Expected an answer link.');
    if (!this.pc) throw new Error('No pending link — create one first.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  closeLink(): void {
    this.teardownLink();
  }

  // ---- internals ----

  private newConnection(): RTCPeerConnection {
    const pc = new this.RtcCtor({ iceServers: [] });
    this.diag = emptyDiagnostics(); // fresh diagnostics per attempt (REQ-11)
    this.disconnectTimer = 0;

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.diag.connHistory.push(s);
      this.fireDiag();
      if (s === 'failed' || s === 'closed') { this.teardownLink(); return; }
      if (s === 'disconnected') {
        // Transient/recoverable per spec (REQ-6): give it a grace window rather
        // than killing a connection that's still completing ICE checks / flapping.
        window.clearTimeout(this.disconnectTimer);
        this.disconnectTimer = window.setTimeout(() => {
          const cur = this.pc?.connectionState;
          if (cur === 'disconnected' || cur === 'failed') this.teardownLink();
        }, DISCONNECT_GRACE_MS);
        return;
      }
      if (s === 'connected') { window.clearTimeout(this.disconnectTimer); this.disconnectTimer = 0; }
    };

    // Diagnostics wiring (REQ-11) — a no-op on the test double (its addEventListener
    // never dispatches); the real peer feeds the debug panel.
    pc.addEventListener('iceconnectionstatechange', () => {
      this.diag.iceHistory.push(pc.iceConnectionState);
      this.fireDiag();
    });
    pc.addEventListener('icegatheringstatechange', () => {
      this.diag.gathering = pc.iceGatheringState;
      this.fireDiag();
    });
    pc.addEventListener('icecandidate', (e) => {
      const cand = (e as RTCPeerConnectionIceEvent).candidate;
      if (!cand?.candidate) return;
      const c = parseCandidate(cand.candidate);
      if (c) { this.diag.localCandidates.push(c); this.fireDiag(); }
    });
    pc.addEventListener('icecandidateerror', (e) => {
      const err = e as RTCPeerConnectionIceErrorEvent;
      this.diag.candidateErrors.push(`${err.errorCode} ${err.errorText ?? ''}`.trim());
      this.fireDiag();
    });

    this.startStatsPoll(pc);
    this.pc = pc;
    return pc;
  }

  /** Poll getStats for the selected candidate pair + remote count (REQ-11). */
  private startStatsPoll(pc: RTCPeerConnection): void {
    window.clearInterval(this.statsTimer);
    if (typeof pc.getStats !== 'function') return; // test double / unsupported
    const tick = async (): Promise<void> => {
      if (this.pc !== pc) return;
      try {
        const stats = await pc.getStats();
        const cands = new Map<string, RTCStats>();
        let remote = 0;
        let best: RTCStats | null = null;
        stats.forEach((r) => {
          if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands.set(r.id, r);
          if (r.type === 'remote-candidate') remote++;
          if (r.type === 'candidate-pair') {
            const p = r as unknown as { nominated?: boolean; state?: string };
            if (p.nominated || p.state === 'succeeded') best = r;
          }
        });
        this.diag.remoteCandidateCount = remote;
        if (best) {
          const p = best as unknown as { localCandidateId?: string; remoteCandidateId?: string };
          const L = p.localCandidateId ? cands.get(p.localCandidateId) : undefined;
          const R = p.remoteCandidateId ? cands.get(p.remoteCandidateId) : undefined;
          if (L && R) this.diag.selectedPair = { local: candFromStat(L), remote: candFromStat(R) };
        }
        this.fireDiag();
      } catch { /* getStats hiccup — keep polling */ }
    };
    this.statsTimer = window.setInterval(() => void tick(), STATS_POLL_MS);
  }

  private createChannels(pc: RTCPeerConnection): void {
    // negotiated: both peers create matching-id channels — no ondatachannel handshake.
    this.control = pc.createDataChannel('sync-control', { negotiated: true, id: 0, ordered: true });
    this.timing = pc.createDataChannel('sync-timing', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    this.control.onopen = () => this.onChannelOpen();
    this.timing.onopen = () => this.onChannelOpen();
    this.control.onclose = () => this.teardownLink();
    this.timing.onclose = () => this.teardownLink();
    this.control.onmessage = (e: MessageEvent) => this.onControl(e.data);
    this.timing.onmessage = (e: MessageEvent) => this.onTiming(e.data);
  }

  private onChannelOpen(): void {
    if (this._linked) return;
    if (this.control?.readyState !== 'open' || this.timing?.readyState !== 'open') return;
    this._linked = true;
    this.startPinging();
    this.firePortsChange();
  }

  private teardownLink(): void {
    const was = this._linked || this.pc !== null;
    this._linked = false;
    window.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = 0;
    window.clearInterval(this.statsTimer);
    this.statsTimer = 0;
    this.timer.stop();
    this.pingCount = 0;
    this.offset.reset();
    for (const ch of [this.control, this.timing]) {
      try { ch?.close(); } catch { /* already gone */ }
    }
    try { this.pc?.close(); } catch { /* already gone */ }
    this.control = null;
    this.timing = null;
    this.pc = null;
    if (was) this.firePortsChange();
  }

  private waitIceComplete(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
      };
      const check = (): void => { if (pc.iceGatheringState === 'complete') finish(); };
      pc.addEventListener('icegatheringstatechange', check);
      const timer = setTimeout(finish, ICE_TIMEOUT_MS); // LAN can gather slowly; don't hang
    });
  }

  // ---- offset estimation (ping/pong) ----

  private startPinging(): void {
    this.pingCount = 0;
    this.timer.start(this.onPingTick, PING_BURST_MS);
  }

  private onPingTick = (): void => {
    this.sendTiming({ t: 'ping', a: this.nowMs() });
    this.pingCount++;
    if (this.pingCount === PING_BURST_COUNT) {
      this.timer.start(this.onPingTick, PING_STEADY_MS); // burst done → settle to 1 Hz
    }
  };

  // ---- receive ----

  private onControl(data: string): void {
    const w = parse(data);
    if (!w) return;
    const now = this.nowMs();
    switch (w.t) {
      case 'start': this.emit({ type: 'start' }, now); break;
      case 'continue': this.emit({ type: 'continue' }, now); break;
      case 'stop': this.emit({ type: 'stop' }, now); break;
      case 'songposition': this.emit({ type: 'songposition', beat: w.beat }, now); break;
      case 'tempo': this.emit({ type: 'tempo', bpm: w.bpm }, now); break;
      case 'meter': this.emit({ type: 'meter', beats: w.beats, unit: w.unit }, now); break;
    }
  }

  private onTiming(data: string): void {
    const w = parse(data);
    if (!w) return;
    const now = this.nowMs();
    switch (w.t) {
      case 'ping':
        this.sendTiming({ t: 'pong', a: w.a, b: now }); // reply unconditionally
        break;
      case 'pong':
        this.offset.addSample({ a: w.a, b: w.b, now });
        break;
      case 'pulse': {
        // Convert the sender's timestamp into our domain (fallback: receipt time).
        const local = this.offset.offsetMs === null ? now : this.offset.toLocal(w.at);
        this.emit({ type: 'pulse' }, local);
        break;
      }
    }
  }

  // ---- send helpers ----

  private sendControl(w: Wire): void {
    if (this.control?.readyState === 'open') this.control.send(JSON.stringify(w));
  }

  private sendTiming(w: Wire): void {
    if (this.timing?.readyState === 'open') this.timing.send(JSON.stringify(w));
  }

  private emit(msg: SyncMessage, at: number): void {
    for (const l of this.messageListeners) l(msg, at);
  }

  private firePortsChange(): void {
    for (const l of this.portListeners) l();
  }

  private fireDiag(): void {
    for (const l of this.diagListeners) l();
  }
}

/** Map an RTCStats candidate row to the pure CandInfo shape. */
function candFromStat(r: RTCStats): CandInfo {
  const c = r as unknown as { candidateType?: string; protocol?: string; address?: string; ip?: string };
  return { type: c.candidateType ?? '?', protocol: c.protocol ?? '?', address: c.address ?? c.ip ?? '?' };
}

/** Finite-number field check — `NaN`/`Infinity` cannot survive JSON, but `null`,
 *  a string, or a missing key all can, and each becomes `NaN` downstream. */
function num(o: Record<string, unknown>, k: string): boolean {
  return typeof o[k] === 'number' && Number.isFinite(o[k]);
}

/**
 * Validate an inbound wire message (webrtc-sync.md REQ-1, untrusted-input.md
 * REQ-8). A **guard**, not a cast: `JSON.parse(data) as Wire` let a peer send
 * `{t:'tempo', bpm:'fast'}` straight through to `Clock.setBpm`, whose clamp
 * returns `NaN` for `NaN` and stalls the scheduler. A paired peer is
 * semi-trusted — pairing proves someone scanned a code, not that they are
 * friendly — so every field is checked and anything malformed is dropped.
 */
function isWire(v: unknown): v is Wire {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case 'start': case 'continue': case 'stop': return true;
    case 'songposition': return num(o, 'beat');
    case 'tempo': return num(o, 'bpm');
    case 'meter': return num(o, 'beats') && num(o, 'unit');
    case 'pulse': return num(o, 'at');
    case 'ping': return num(o, 'a');
    case 'pong': return num(o, 'a') && num(o, 'b');
    default: return false;
  }
}

/** Parse + guard one channel message. `null` means "drop it" — both channels
 *  already tolerate loss, so dropping is cheaper and safer than repairing. */
function parse(data: unknown): Wire | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isWire(parsed) ? parsed : null;
}
