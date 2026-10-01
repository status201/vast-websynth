// @vitest-environment jsdom
// webrtc-sync REQ-a-failed-scan-leaves-the-camera-off: the decoder is obtained
// before the camera, so a jsQR chunk that will not load never starts a stream.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openSyncPairModal } from '../../src/ui/components/sync-pair-modal';
import { WebRtcSyncTransport } from '../../src/audio/webrtc-sync-transport';
import type { TickTimer } from '../../src/audio/transport/tick-timer';
import { makeFakeRtc } from '../audio/fake-rtc';

// The lazily imported decoder chunk fails to load, as it does offline.
vi.mock('../../src/vendor/jsqr', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const noopTimer: TickTimer = { start() {}, stop() {} };
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function openJoinStep(): void {
  const t = new WebRtcSyncTransport({ rtc: makeFakeRtc().ctor, timer: noopTimer, nowMs: () => 0 });
  openSyncPairModal(t, { setMode: vi.fn() });
  (byId('sync-pair-join') as HTMLElement).click();
}

const errorText = () => byId('sync-pair-error')?.textContent ?? '';

let getUserMedia: ReturnType<typeof vi.fn>;
const origMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

beforeEach(() => {
  getUserMedia = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  if (origMedia) Object.defineProperty(navigator, 'mediaDevices', origMedia);
  else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
});

describe('QR scan failure paths', () => {
  it('a decoder that fails to load never asks for the camera, and says so', async () => {
    openJoinStep();
    (byId('sync-pair-scan') as HTMLElement).click();
    await waitFor(() => errorText() !== '');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
    expect(errorText()).toContain('QR decoder failed to download');
    expect(errorText()).not.toContain('Camera unavailable');
  });

  it('offline, the decoder failure reads as the not-downloaded sentence', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      openJoinStep();
      (byId('sync-pair-scan') as HTMLElement).click();
      await waitFor(() => errorText() !== '');
      expect(errorText()).toContain("you're offline");
      expect(getUserMedia).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('with a decoder, a refused camera still reads "Camera unavailable"', async () => {
    vi.stubGlobal('BarcodeDetector', class { detect() { return Promise.resolve([]); } });
    openJoinStep();
    (byId('sync-pair-scan') as HTMLElement).click();
    await waitFor(() => errorText() !== '');
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(errorText()).toBe('Camera unavailable — paste the code instead.');
    expect(document.querySelector('video')).toBeNull();
  });
});
