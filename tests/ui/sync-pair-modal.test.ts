// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { openSyncPairModal, renderQr, renderDiagnosticsInto } from '../../src/ui/components/sync-pair-modal';
import { emptyDiagnostics } from '../../src/audio/webrtc-diagnostics';
import { Modal } from '../../src/ui/components/modal';
import { WebRtcSyncTransport } from '../../src/audio/webrtc-sync-transport';
import type { TickTimer } from '../../src/audio/transport/tick-timer';
import { qrcode } from '../../src/vendor/qr';
import { makeFakeRtc } from '../audio/fake-rtc';

const noopTimer: TickTimer = { start() {}, stop() {} };
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const valueOf = (id: string) => (byId(id) as HTMLTextAreaElement | null)?.value ?? '';

/** Poll until `cond` holds (the async offer/answer chains span many microtasks). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function transport() {
  return new WebRtcSyncTransport({ rtc: makeFakeRtc().ctor, timer: noopTimer, nowMs: () => 0 });
}
const syncStub = () => ({ setMode: vi.fn() });

afterEach(() => {
  document.body.replaceChildren();
});

describe('sync-pair-modal (wizard)', () => {
  it('opens on the Choose step (Create + Join, no offer field yet)', () => {
    openSyncPairModal(transport(), syncStub());
    expect(byId('sync-pair-create')).toBeTruthy();
    expect(byId('sync-pair-join')).toBeTruthy();
    expect(byId('sync-pair-status')).toBeTruthy();
    expect(byId('sync-pair-close')).toBeTruthy();
    // The exchange fields appear only after a role is chosen.
    expect(byId('sync-pair-offer')).toBeNull();
  });

  it('Create sets Master and reaches the offer QR', async () => {
    const sync = syncStub();
    openSyncPairModal(transport(), sync);
    (byId('sync-pair-create') as HTMLElement).click();
    expect(sync.setMode).toHaveBeenCalledWith('master');
    // Offer field is the readonly output; it fills once the link is generated.
    expect((byId('sync-pair-offer') as HTMLTextAreaElement).readOnly).toBe(true);
    await waitFor(() => valueOf('sync-pair-offer').startsWith('WS2.'));
    expect(byId('sync-pair-qr')).toBeTruthy();
  });

  it('Join sets Slave and shows the offer input + Generate', () => {
    const sync = syncStub();
    openSyncPairModal(transport(), sync);
    (byId('sync-pair-join') as HTMLElement).click();
    expect(sync.setMode).toHaveBeenCalledWith('slave');
    expect((byId('sync-pair-offer') as HTMLTextAreaElement).readOnly).toBe(false);
    expect(byId('sync-pair-generate')).toBeTruthy();
  });

  it('does not render a Scan button without a camera', () => {
    openSyncPairModal(transport(), syncStub());
    (byId('sync-pair-join') as HTMLElement).click(); // slave step 1 has the scan panel
    expect(byId('sync-pair-scan')).toBeNull();
  });

  it('renders a Scan button when a camera is present, even without BarcodeDetector', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new Error('not in jsdom')) },
    });
    try {
      expect((globalThis as Record<string, unknown>).BarcodeDetector).toBeUndefined();
      openSyncPairModal(transport(), syncStub());
      (byId('sync-pair-join') as HTMLElement).click();
      expect(byId('sync-pair-scan')).toBeTruthy();
    } finally {
      if (orig) Object.defineProperty(navigator, 'mediaDevices', orig);
      else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  it('a full Join flow links the transport and shows Linked', async () => {
    const fake = makeFakeRtc();
    const host = new WebRtcSyncTransport({ rtc: fake.ctor, timer: noopTimer, nowMs: () => 0 });
    const guest = new WebRtcSyncTransport({ rtc: fake.ctor, timer: noopTimer, nowMs: () => 0 });
    const offer = await host.createLink();

    openSyncPairModal(guest, syncStub());
    (byId('sync-pair-join') as HTMLElement).click();
    (byId('sync-pair-offer') as HTMLTextAreaElement).value = offer;
    (byId('sync-pair-generate') as HTMLElement).click();
    await waitFor(() => valueOf('sync-pair-answer').startsWith('WS2.'));

    const answer = valueOf('sync-pair-answer');
    await host.acceptAnswer(answer); // completes the link → guest fires onPortsChange
    expect(guest.linked).toBe(true);
    expect(byId('sync-pair-status')!.textContent).toContain('Linked');
  });

  it('shows an inline error for a corrupt paste in Join', async () => {
    openSyncPairModal(transport(), syncStub());
    (byId('sync-pair-join') as HTMLElement).click();
    (byId('sync-pair-offer') as HTMLTextAreaElement).value = 'not a real link';
    (byId('sync-pair-generate') as HTMLElement).click();
    await waitFor(() => Boolean(byId('sync-pair-error')?.textContent));
    expect(byId('sync-pair-error')!.textContent).toBeTruthy();
  });

  it('does not close on a backdrop click; Close does (REQ-10)', () => {
    openSyncPairModal(transport(), syncStub());
    const backdrop = document.querySelector(`.${Modal.backdropClass}`) as HTMLElement;
    backdrop.dispatchEvent(new Event('pointerdown')); // target === backdrop
    expect(backdrop.classList.contains('hidden')).toBe(false); // still open
    (byId('sync-pair-close') as HTMLElement).click();
    expect(backdrop.classList.contains('hidden')).toBe(true);
  });

  it('surfaces readable guidance naming virtual adapters when the link never opens', async () => {
    const fake = makeFakeRtc();
    const host = new WebRtcSyncTransport({ rtc: fake.ctor, timer: noopTimer, nowMs: () => 0 });
    const guest = new WebRtcSyncTransport({ rtc: fake.ctor, timer: noopTimer, nowMs: () => 0 });
    const offer = await host.createLink();

    openSyncPairModal(guest, syncStub());
    (byId('sync-pair-join') as HTMLElement).click();
    (byId('sync-pair-offer') as HTMLTextAreaElement).value = offer;
    (byId('sync-pair-generate') as HTMLElement).click();
    await waitFor(() => valueOf('sync-pair-answer').startsWith('WS2.'));

    // The host never accepts the answer; the guest's peer connection fails.
    fake.peers.at(-1)!.fail();
    expect(guest.linked).toBe(false);
    const err = byId('sync-pair-error')!;
    expect(err.textContent).toContain("Couldn't connect");
    expect(err.textContent).toContain('virtual');
    expect((err as HTMLElement).style.textTransform).toBe('none'); // rendered readably
  });

  it('shows a non-blocking HTTPS banner on an insecure origin, choices still render', () => {
    const orig = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => false });
    try {
      openSyncPairModal(transport(), syncStub());
      expect(byId('sync-pair-insecure')).toBeTruthy();
      expect(byId('sync-pair-create')).toBeTruthy();
      expect(byId('sync-pair-join')).toBeTruthy();
    } finally {
      if (orig) Object.defineProperty(window, 'isSecureContext', orig);
      else Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    }
  });

  // Regression (webrtc-sync REQ-5): the QR must be drawn 1px/module and upscaled,
  // never a big bitmap CSS-clamped down (the v1 ~2px/module unscannable bug).
  it('has a (hidden) debug panel wired on open', () => {
    openSyncPairModal(transport(), syncStub());
    expect(byId('sync-pair-debug')).toBeTruthy(); // present, revealed once an attempt has data
  });

  it('renders diagnostics (candidates + hint) into the debug panel (REQ-11)', () => {
    const body = document.createElement('div');
    const d = emptyDiagnostics();
    d.iceHistory = ['checking', 'disconnected'];
    d.remoteCandidateCount = 2;
    d.localCandidates = [
      { type: 'host', protocol: 'udp', address: '192.168.68.112' },
      { type: 'host', protocol: 'udp', address: '192.168.56.1' },
    ];
    renderDiagnosticsInto(body, d);
    expect(body.textContent).toContain('ICE: checking → disconnected');
    expect(body.textContent).toContain('192.168.68.112');
    expect(body.textContent).toContain('192.168.56.1');
    expect(body.textContent).toMatch(/virtual adapter|VPN/i); // plain-language hint
  });

  it('renders the QR upscaled (1px/module + quiet zone), never downscaled', () => {
    const canvas = document.createElement('canvas');
    const payload = 'WS2.r.' + 'A'.repeat(1200); // ~ a real (dense) SDP blob
    renderQr(canvas, payload);

    const q = qrcode(0, 'L');
    q.addData(payload);
    q.make();
    const dim = q.getModuleCount() + 8; // 1px/module + a 4-module quiet zone per side

    expect(canvas.width).toBe(dim);
    expect(canvas.height).toBe(dim);
    const displayPx = parseInt(canvas.style.width, 10);
    expect(displayPx).toBeGreaterThan(180);       // not clamped to the old 180px
    expect(displayPx).toBeGreaterThanOrEqual(dim); // upscaled — bitmap never shrunk
  });
});
