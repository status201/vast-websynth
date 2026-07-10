// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { openSyncPairModal, renderQr } from '../../src/ui/components/sync-pair-modal';
import { WebRtcSyncTransport } from '../../src/audio/webrtc-sync-transport';
import type { TickTimer } from '../../src/audio/transport/tick-timer';
import { qrcode } from '../../src/vendor/qr';
import { makeFakeRtc } from '../audio/fake-rtc';

const noopTimer: TickTimer = { start() {}, stop() {} };
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

/** Poll until `cond` holds (the async offer/answer chains span many microtasks). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const valueOf = (id: string) => (byId(id) as HTMLTextAreaElement | null)?.value ?? '';

function transport() {
  return new WebRtcSyncTransport({ rtc: makeFakeRtc().ctor, timer: noopTimer, nowMs: () => 0 });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('sync-pair-modal', () => {
  it('opens in Create mode with the offer/answer/status fields', () => {
    openSyncPairModal(transport());
    expect(byId('sync-pair-create')).toBeTruthy();
    expect(byId('sync-pair-join')).toBeTruthy();
    expect(byId('sync-pair-offer')).toBeTruthy();
    expect(byId('sync-pair-answer')).toBeTruthy();
    expect(byId('sync-pair-status')).toBeTruthy();
    // Create mode: the offer field is the readonly output.
    expect((byId('sync-pair-offer') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('generates an offer blob into the readonly field on open', async () => {
    openSyncPairModal(transport());
    await waitFor(() => valueOf('sync-pair-offer').startsWith('WS2.'));
    expect(valueOf('sync-pair-offer').startsWith('WS2.')).toBe(true);
  });

  it('switching to Join makes the offer field an input and shows Generate', () => {
    openSyncPairModal(transport());
    (byId('sync-pair-join') as HTMLElement).click();
    expect((byId('sync-pair-offer') as HTMLTextAreaElement).readOnly).toBe(false);
    expect(byId('sync-pair-generate')).toBeTruthy();
  });

  it('does not render a Scan button when BarcodeDetector is absent', () => {
    openSyncPairModal(transport());
    expect(byId('sync-pair-scan')).toBeNull();
  });

  it('renders a Scan button when BarcodeDetector is available', () => {
    const g = globalThis as Record<string, unknown>;
    g.BarcodeDetector = class {};
    try {
      openSyncPairModal(transport());
      expect(byId('sync-pair-scan')).toBeTruthy();
    } finally {
      delete g.BarcodeDetector;
    }
  });

  it('a full pair flow links the transport and shows Linked', async () => {
    const fake = makeFakeRtc();
    const host = new WebRtcSyncTransport({ rtc: fake.ctor, timer: noopTimer, nowMs: () => 0 });
    const guest = new WebRtcSyncTransport({ rtc: fake.ctor, timer: noopTimer, nowMs: () => 0 });
    const offer = await host.createLink();

    openSyncPairModal(guest);
    await waitFor(() => valueOf('sync-pair-offer').startsWith('WS2.')); // Create-mode offer settled
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
    openSyncPairModal(transport());
    (byId('sync-pair-join') as HTMLElement).click();
    (byId('sync-pair-offer') as HTMLTextAreaElement).value = 'not a real link';
    (byId('sync-pair-generate') as HTMLElement).click();
    await waitFor(() => Boolean(byId('sync-pair-error')?.textContent));
    expect(byId('sync-pair-error')!.textContent).toBeTruthy();
  });

  // Regression (webrtc-sync REQ-5): the v1 modal drew a big bitmap and
  // CSS-clamped it *down* to 180px, leaving ~2px/module — unscannable by any
  // reader. The QR must be drawn 1px/module and upscaled, never downscaled.
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

  it('shows a non-blocking HTTPS banner on an insecure origin, flows still render', () => {
    const orig = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => false });
    try {
      openSyncPairModal(transport());
      expect(byId('sync-pair-insecure')).toBeTruthy();
      expect(byId('sync-pair-create')).toBeTruthy(); // copy-paste flow still there
      expect(byId('sync-pair-offer')).toBeTruthy();
    } finally {
      if (orig) Object.defineProperty(window, 'isSecureContext', orig);
      else delete (window as unknown as { isSecureContext?: boolean }).isSecureContext;
    }
  });

  it('surfaces actionable guidance when the link never opens (REQ-9)', async () => {
    const fake = makeFakeRtc();
    const host = new WebRtcSyncTransport({ rtc: fake.ctor, timer: noopTimer, nowMs: () => 0 });
    const guest = new WebRtcSyncTransport({ rtc: fake.ctor, timer: noopTimer, nowMs: () => 0 });
    const offer = await host.createLink();

    openSyncPairModal(guest);
    await waitFor(() => valueOf('sync-pair-offer').startsWith('WS2.'));
    (byId('sync-pair-join') as HTMLElement).click();
    (byId('sync-pair-offer') as HTMLTextAreaElement).value = offer;
    (byId('sync-pair-generate') as HTMLElement).click();
    await waitFor(() => valueOf('sync-pair-answer').startsWith('WS2.'));

    // The host never accepts the answer; the guest's peer connection fails.
    fake.peers.at(-1)!.fail();
    expect(guest.linked).toBe(false);
    expect(byId('sync-pair-error')!.textContent).toContain("Couldn't connect");
  });
});
