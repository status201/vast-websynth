/**
 * Hand-rolled fake WebRTC for unit tests (jsdom has no RTCPeerConnection).
 * Structurally satisfies the slice of `RTCPeerConnection` / `RTCDataChannel`
 * the WebRtcSyncTransport uses. Two connections built from the SAME factory
 * loopback: negotiated channels with matching ids are paired at answer time,
 * and `send` delivers synchronously to the peer's `onmessage` (deterministic
 * under fake timers). SDP is a `FAKE:<token>` string; a shared registry links
 * the two peers by token — modelling the offer→answer handshake.
 *
 * Model of a full pairing: host.createOffer registers under its token; guest
 * setRemoteDescription(offer) links the two; host setRemoteDescription(answer)
 * opens every matched channel on both sides (fires `onopen`).
 */

let counter = 0;

class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  peer: FakeDataChannel | null = null;
  constructor(readonly label: string, readonly id: number) {}

  send(data: string): void {
    if (this.peer && this.peer.readyState === 'open') this.peer.onmessage?.({ data });
  }
  close(): void {
    const peer = this.peer;
    this.localClose();
    peer?.localClose();
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  localClose(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
}

export interface FakeRtc {
  /** The `RTCPeerConnection`-shaped ctor to inject into WebRtcSyncTransport. */
  ctor: typeof RTCPeerConnection;
  /** Peers created so far (host first, then guest) — for close simulation. */
  peers: FakePeerConnection[];
}

class FakePeerConnection {
  iceGatheringState: 'new' | 'gathering' | 'complete' = 'complete';
  connectionState: RTCPeerConnectionState = 'connected';
  localDescription: { type: string; sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;

  private readonly token = `tok-${counter++}`;
  private readonly channels = new Map<number, FakeDataChannel>();
  private remote: FakePeerConnection | null = null;

  constructor(private readonly registry: Map<string, FakePeerConnection>) {}

  createDataChannel(label: string, init: { id: number }): FakeDataChannel {
    const ch = new FakeDataChannel(label, init.id);
    this.channels.set(init.id, ch);
    return ch;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    this.registry.set(this.token, this);
    return { type: 'offer', sdp: `FAKE:${this.token}` };
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    this.registry.set(this.token, this);
    return { type: 'answer', sdp: `FAKE:${this.token}` };
  }

  async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    const other = this.registry.get(desc.sdp.replace('FAKE:', ''));
    if (!other) return;
    this.remote = other;
    other.remote = this;
    if (desc.type === 'answer') openBetween(this, other); // handshake complete
  }

  addEventListener(): void { /* iceGatheringState is already 'complete' */ }
  removeEventListener(): void {}

  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    for (const ch of this.channels.values()) ch.localClose();
    this.onconnectionstatechange?.();
  }

  /** Test helper: force a connection failure (drops both peers' channels). */
  fail(): void {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }

  /** Test helper: drive an arbitrary connectionState transition (e.g. the
   *  transient 'disconnected' → 'connected' recovery path). */
  setConnectionState(s: RTCPeerConnectionState): void {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }

  channel(id: number): FakeDataChannel | undefined {
    return this.channels.get(id);
  }
}

function openBetween(a: FakePeerConnection, b: FakePeerConnection): void {
  const ca = a as unknown as { channels: Map<number, FakeDataChannel> };
  const cb = b as unknown as { channels: Map<number, FakeDataChannel> };
  for (const [id, chA] of ca.channels) {
    const chB = cb.channels.get(id);
    if (!chB) continue;
    chA.peer = chB;
    chB.peer = chA;
    chA.open();
    chB.open();
  }
}

export function makeFakeRtc(): FakeRtc {
  const registry = new Map<string, FakePeerConnection>();
  const peers: FakePeerConnection[] = [];
  class Ctor extends FakePeerConnection {
    constructor(_config?: RTCConfiguration) {
      super(registry);
      peers.push(this);
    }
  }
  return { ctor: Ctor as unknown as typeof RTCPeerConnection, peers };
}

export type { FakePeerConnection };
