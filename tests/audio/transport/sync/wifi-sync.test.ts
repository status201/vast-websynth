// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WifiSyncTransport } from '../../../../src/audio/transport/sync/wifi-sync';
import { emptyDiagnostics } from '../../../../src/audio/transport/sync/webrtc-diagnostics';
import type { TickTimer } from '../../../../src/audio/transport/tick-timer';
import type { SyncMessage } from '../../../../src/audio/transport/sync/sync-types';
import { makeFakeRtc } from '../../fake-rtc';

/**
 * webrtc-sync.md REQ-the-wifi-transport-loads-at-pairing: the boot-time facade is an
 * unlinked transport until a pairing step loads the body, its listeners carry
 * over, and a failed load rejects that step and retries on the next.
 */

const noopTimer: TickTimer = { start() { /* manual */ }, stop() { /* manual */ } };

afterEach(() => {
  vi.doUnmock('../../../../src/audio/transport/sync/webrtc-sync-transport');
  vi.resetModules();
});

describe('WifiSyncTransport', () => {
  it('is an unlinked transport before anyone pairs', () => {
    const t = new WifiSyncTransport();
    expect(t.linked).toBe(false);
    expect(t.ports()).toEqual({ ins: 0, outs: 0 });
    expect(t.diagnostics).toEqual(emptyDiagnostics());
    expect(() => t.send({ type: 'start' })).not.toThrow();
    expect(() => t.closeLink()).not.toThrow();
  });

  it('pairs through the loaded body, relaying listeners subscribed before it existed', async () => {
    const rtc = makeFakeRtc();
    const host = new WifiSyncTransport({ rtc: rtc.ctor, timer: noopTimer, nowMs: () => 1000 });
    const guest = new WifiSyncTransport({ rtc: rtc.ctor, timer: noopTimer, nowMs: () => 1000 });
    const ports = vi.fn();
    const diag = vi.fn();
    const got: SyncMessage[] = [];
    host.onPortsChange(ports);
    host.onDiagnostics(diag);
    guest.onMessage((m) => got.push(m));

    await host.acceptAnswer(await guest.acceptOffer(await host.createLink()));

    expect(host.linked).toBe(true);
    expect(guest.linked).toBe(true);
    expect(host.ports()).toEqual({ ins: 1, outs: 1 });
    expect(ports).toHaveBeenCalled();
    // The fake RTC never moves a connection state, so fire the body's own event.
    (host as unknown as { body: { fireDiag(): void } }).body.fireDiag();
    expect(diag).toHaveBeenCalled();
    host.send({ type: 'stop' });
    await vi.waitFor(() => expect(got).toContainEqual({ type: 'stop' }));
  });

  it('rejects a pairing step whose load fails, and the next step retries', async () => {
    vi.resetModules();
    vi.doMock('../../../../src/audio/transport/sync/webrtc-sync-transport', () => { throw new Error('offline'); });
    const fresh = await import('../../../../src/audio/transport/sync/wifi-sync');
    const t = new fresh.WifiSyncTransport({ rtc: makeFakeRtc().ctor, timer: noopTimer });
    await expect(t.createLink()).rejects.toThrow();
    expect(t.linked).toBe(false);

    vi.doUnmock('../../../../src/audio/transport/sync/webrtc-sync-transport');
    await expect(t.createLink()).resolves.toEqual(expect.any(String));
  });
});
