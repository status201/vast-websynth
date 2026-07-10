import { describe, it, expect } from 'vitest';
import { jsQR } from '../../src/vendor/jsqr';
import { qrcode } from '../../src/vendor/qr';

/**
 * Pins the vendored jsQR decoder end-to-end (webrtc-sync REQ-5/REQ-7): a QR the
 * vendored *encoder* produces, rasterized the way the pair modal renders it
 * (1px/module + a 4-module quiet zone, upscaled), decodes back to the exact
 * blob. This is the scan path on devices without a platform BarcodeDetector.
 */
function rasterize(text: string, scale: number): { data: Uint8ClampedArray; w: number } {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const dim = (count + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255); // white RGBA
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = (((quiet + r) * scale + y) * dim + ((quiet + c) * scale + x)) * 4;
          data[px] = data[px + 1] = data[px + 2] = 0; // black module
        }
      }
    }
  }
  return { data, w: dim };
}

describe('vendored jsQR decoder', () => {
  it('round-trips a dense SDP-sized blob from the vendored encoder', () => {
    const blob = 'WS2.c.' + 'aB3-_x'.repeat(140); // ~840 chars → high-version QR
    const { data, w } = rasterize(blob, 5);
    const res = jsQR(data, w, w);
    expect(res).not.toBeNull();
    expect(res!.data).toBe(blob);
  });

  it('returns null on a blank frame', () => {
    const w = 120;
    const blank = new Uint8ClampedArray(w * w * 4).fill(255);
    expect(jsQR(blank, w, w)).toBeNull();
  });
});
