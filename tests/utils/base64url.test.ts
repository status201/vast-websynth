import { describe, it, expect } from 'vitest';
import { toBase64Url, fromBase64Url } from '../../src/utils/base64url';

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n);

describe('base64url', () => {
  it('round-trips the empty payload', () => {
    expect(toBase64Url(bytes())).toBe('');
    expect(fromBase64Url('')).toEqual(bytes());
  });

  it('round-trips every padding remainder (length % 3 = 0, 1, 2)', () => {
    for (const len of [3, 4, 5, 6]) {
      const src = new Uint8Array(len).map((_, i) => i * 17);
      expect(fromBase64Url(toBase64Url(src))).toEqual(src);
    }
  });

  it('strips padding from the encoded form', () => {
    expect(toBase64Url(bytes(1))).not.toContain('=');
    expect(toBase64Url(bytes(1, 2))).not.toContain('=');
  });

  it('round-trips bytes >= 0x80 (the high half, where btoa is byte-sensitive)', () => {
    const src = bytes(0x80, 0xff, 0xfe, 0x00, 0x7f);
    expect(fromBase64Url(toBase64Url(src))).toEqual(src);
  });

  it('round-trips every byte value', () => {
    const src = new Uint8Array(256).map((_, i) => i);
    expect(fromBase64Url(toBase64Url(src))).toEqual(src);
  });

  it('emits only URL-safe characters (no + or /)', () => {
    // 0xfb 0xff encodes to "+/" in standard base64.
    const encoded = toBase64Url(bytes(0xfb, 0xff, 0xfe));
    expect(encoded).not.toMatch(/[+/]/);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts a padded input as well as an unpadded one', () => {
    const src = bytes(1, 2);
    const unpadded = toBase64Url(src);
    expect(fromBase64Url(unpadded + '=='.slice(0, (4 - (unpadded.length % 4)) % 4))).toEqual(src);
  });

  it('round-trips a payload larger than the fromCharCode chunk size', () => {
    const src = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 256);
    expect(fromBase64Url(toBase64Url(src))).toEqual(src);
  });

  it('throws on malformed input', () => {
    expect(() => fromBase64Url('!!!!')).toThrow();
  });
});
