// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { WebRtcSyncTransport } from '../../src/audio/webrtc-sync-transport';
import type { TickTimer } from '../../src/audio/transport/tick-timer';
import type { SyncMessage } from '../../src/audio/transport/sync/sync-types';
import { makeFakeRtc } from './fake-rtc';

/** A hand-fired ping timer so ping/pong is deterministic (no wall-clock). */
class ManualTimer implements TickTimer {
  private cb: (() => void) | null = null;
  start(cb: () => void): void { this.cb = cb; }
  stop(): void { this.cb = null; }
  fire(): void { this.cb?.(); }
}

interface Pair {
  host: WebRtcSyncTransport;
  guest: WebRtcSyncTransport;
  rtc: ReturnType<typeof makeFakeRtc>;
  hostTimer: ManualTimer;
  guestTimer: ManualTimer;
  setHostNow: (n: number) => void;
  setGuestNow: (n: number) => void;
}

async function linkPair(hostNow0 = 1000, guestNow0 = 1000): Promise<Pair> {
  const rtc = makeFakeRtc();
  let hostNow = hostNow0;
  let guestNow = guestNow0;
  const hostTimer = new ManualTimer();
  const guestTimer = new ManualTimer();
  const host = new WebRtcSyncTransport({ rtc: rtc.ctor, timer: hostTimer, nowMs: () => hostNow });
  const guest = new WebRtcSyncTransport({ rtc: rtc.ctor, timer: guestTimer, nowMs: () => guestNow });
  const offer = await host.createLink();
  const answer = await guest.acceptOffer(offer);
  await host.acceptAnswer(answer);
  return {
    host, guest, rtc, hostTimer, guestTimer,
    setHostNow: (n) => { hostNow = n; },
    setGuestNow: (n) => { guestNow = n; },
  };
}

describe('WebRtcSyncTransport', () => {
  it('links two transports over the fake RTC (ports 1/1)', async () => {
    const { host, guest } = await linkPair();
    expect(host.linked).toBe(true);
    expect(guest.linked).toBe(true);
    expect(host.ports()).toEqual({ ins: 1, outs: 1 });
  });

  it('is a no-op (never throws) while unpaired', () => {
    const rtc = makeFakeRtc();
    const t = new WebRtcSyncTransport({ rtc: rtc.ctor, timer: new ManualTimer() });
    expect(() => t.send({ type: 'start' })).not.toThrow();
    expect(t.linked).toBe(false);
    expect(t.ports()).toEqual({ ins: 0, outs: 0 });
  });

  it('relays control messages to the peer', async () => {
    const { host, guest } = await linkPair();
    const seen: SyncMessage[] = [];
    guest.onMessage((m) => seen.push(m));
    host.send({ type: 'start' });
    host.send({ type: 'stop' });
    host.send({ type: 'tempo', bpm: 130 });
    host.send({ type: 'songposition', beat: 12 });
    expect(seen).toEqual([
      { type: 'start' }, { type: 'stop' },
      { type: 'tempo', bpm: 130 }, { type: 'songposition', beat: 12 },
    ]);
  });

  it('routes control vs timing messages to the right channel', async () => {
    const { host, rtc } = await linkPair();
    const control = rtc.peers[0]!.channel(0)!;
    const timing = rtc.peers[0]!.channel(1)!;
    const cSpy = vi.spyOn(control, 'send');
    const tSpy = vi.spyOn(timing, 'send');
    host.send({ type: 'stop' });
    host.send({ type: 'pulse' }, 42);
    expect(cSpy).toHaveBeenCalledWith(JSON.stringify({ t: 'stop' }));
    expect(tSpy).toHaveBeenCalledWith(JSON.stringify({ t: 'pulse', at: 42 }));
  });

  it('falls back to local receipt time for a pulse while the offset is cold', async () => {
    const { host, guest } = await linkPair(5000, 1000);
    const seen: Array<{ msg: SyncMessage; at: number }> = [];
    guest.onMessage((msg, at) => seen.push({ msg, at }));
    host.send({ type: 'pulse' }, 9999); // cold estimator ignores the sender stamp
    expect(seen).toEqual([{ msg: { type: 'pulse' }, at: 1000 }]); // guest's local now
  });

  it('converts a pulse timestamp into the receiver domain once the offset is warm', async () => {
    const { host, guest, hostTimer, guestTimer } = await linkPair(5000, 1000);
    // One ping each way warms both estimators (rtt 0 → guest offset = 5000-1000).
    guestTimer.fire();
    hostTimer.fire();
    const seen: Array<{ msg: SyncMessage; at: number }> = [];
    guest.onMessage((msg, at) => seen.push({ msg, at }));
    host.send({ type: 'pulse' }, 6000); // 6000 - offset(4000) = 2000 in guest's domain
    expect(seen).toEqual([{ msg: { type: 'pulse' }, at: 2000 }]);
  });

  it('a channel close degrades ports and fires onPortsChange', async () => {
    const { host, guest } = await linkPair();
    let fired = false;
    host.onPortsChange(() => { fired = true; });
    guest.closeLink(); // closes both peers' channels
    expect(fired).toBe(true);
    expect(host.linked).toBe(false);
    expect(host.ports()).toEqual({ ins: 0, outs: 0 });
  });

  it('a connection failure tears the link down', async () => {
    const { host, rtc } = await linkPair();
    rtc.peers[0]!.fail(); // host pc → connectionState 'failed'
    expect(host.linked).toBe(false);
    expect(host.ports()).toEqual({ ins: 0, outs: 0 });
  });

  it("'disconnected' is transient — a recovery within the grace window keeps the link (REQ-no-subscriber-can-wedge-the-clock)", async () => {
    const { host, rtc } = await linkPair();
    expect(host.linked).toBe(true);
    vi.useFakeTimers();
    try {
      rtc.peers[0]!.setConnectionState('disconnected');
      expect(host.linked).toBe(true);                 // grace — not torn down
      rtc.peers[0]!.setConnectionState('connected');  // recovered
      vi.advanceTimersByTime(10_000);
      expect(host.linked).toBe(true);                 // recovery cancelled the teardown
    } finally { vi.useRealTimers(); }
  });

  it("'disconnected' that persists past the grace window tears down (REQ-no-subscriber-can-wedge-the-clock)", async () => {
    const { host, rtc } = await linkPair();
    vi.useFakeTimers();
    try {
      rtc.peers[0]!.setConnectionState('disconnected');
      expect(host.linked).toBe(true);                 // still within grace
      vi.advanceTimersByTime(10_000);
      expect(host.linked).toBe(false);                // grace elapsed, still disconnected → torn down
    } finally { vi.useRealTimers(); }
  });
});

// webrtc-sync.md REQ-the-transport-opens-two-channels / untrusted-input.md REQ-deserialized-state-is-validated-never-cast. `JSON.parse(data) as Wire`
// was a cast, not a check: a peer could send {t:'tempo', bpm:'fast'} straight
// through to Clock.setBpm, whose clamp returns NaN for NaN and stalls the
// scheduler. Pairing proves someone scanned a code, not that they are friendly.
describe('WebRtcSyncTransport wire guard', () => {
  /** Inject a raw frame at the guest as if the peer had sent it. */
  async function injectAtGuest(raw: string, channelId: 0 | 1): Promise<SyncMessage[]> {
    const { guest, rtc } = await linkPair();
    const seen: SyncMessage[] = [];
    guest.onMessage((m) => seen.push(m));
    rtc.peers[1]!.channel(channelId)!.onmessage?.({ data: raw });
    return seen;
  }

  it('drops control messages with a non-numeric or missing field', async () => {
    for (const raw of [
      '{"t":"tempo","bpm":"fast"}',
      '{"t":"tempo","bpm":null}',
      '{"t":"tempo"}',
      '{"t":"songposition","beat":"soon"}',
      '{"t":"songposition"}',
      '{"t":"???"}',
      '{"t":42}',
      'null',
      '[]',
      'not json at all',
    ]) {
      expect(await injectAtGuest(raw, 0), raw).toEqual([]);
    }
  });

  it('drops timing messages with a non-numeric field', async () => {
    for (const raw of ['{"t":"pulse","at":"now"}', '{"t":"pulse"}', '{"t":"pong","a":1}']) {
      expect(await injectAtGuest(raw, 1), raw).toEqual([]);
    }
  });

  it('still passes well-formed messages through (regression)', async () => {
    expect(await injectAtGuest('{"t":"tempo","bpm":130}', 0)).toEqual([{ type: 'tempo', bpm: 130 }]);
    expect(await injectAtGuest('{"t":"start"}', 0)).toEqual([{ type: 'start' }]);
  });
});

// webrtc-sync.md REQ-a-join-carries-its-time (v8). A DataChannel sends at once, so a join's
// schedule rides the wire: without it a WiFi slave had only the arrival time,
// and the timing channel's first post-jump pulse could overtake the join.
describe('WebRtcSyncTransport join time (v8)', () => {
  it('carries a scheduled join on the wire, converted into the receiver domain', async () => {
    const { host, guest, rtc, hostTimer, guestTimer } = await linkPair(5000, 1000);
    guestTimer.fire(); // warm both estimators: guest offset = 5000 - 1000
    hostTimer.fire();
    const control = rtc.peers[0]!.channel(0)!;
    const cSpy = vi.spyOn(control, 'send');
    const seen: SyncMessage[] = [];
    guest.onMessage((m) => seen.push(m));
    host.send({ type: 'continue' }, 6000);
    host.send({ type: 'start' }, 6100);
    expect(cSpy).toHaveBeenCalledWith(JSON.stringify({ t: 'continue', at: 6000 }));
    expect(seen).toEqual([{ type: 'continue', at: 2000 }, { type: 'start', at: 2100 }]);
  });

  it('passes no time while the offset is cold, or from a peer that sends none', async () => {
    const { host, guest } = await linkPair(5000, 1000);
    const seen: SyncMessage[] = [];
    guest.onMessage((m) => seen.push(m));
    host.send({ type: 'continue' }, 6000); // cold: an unconverted sender time means nothing here
    host.send({ type: 'start' });          // unscheduled, as an older peer sends it
    expect(seen).toEqual([{ type: 'continue' }, { type: 'start' }]);
  });
});

describe('WebRtcSyncTransport join time guard (v8)', () => {
  it('drops a join whose time is present but not a finite number', async () => {
    for (const raw of ['{"t":"continue","at":"soon"}', '{"t":"start","at":null}', '{"t":"start","at":[]}']) {
      const { guest, rtc } = await linkPair();
      const seen: SyncMessage[] = [];
      guest.onMessage((m) => seen.push(m));
      rtc.peers[1]!.channel(0)!.onmessage?.({ data: raw });
      expect(seen, raw).toEqual([]);
    }
  });
});
