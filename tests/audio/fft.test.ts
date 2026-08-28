import { describe, it, expect } from 'vitest';
import { fftInPlace, isPowerOfTwo } from '../../src/audio/recorder/fft';

/** A real cosine at exactly `bin` cycles across `n` samples. */
function cosBin(n: number, bin: number, amp = 1): { re: Float32Array; im: Float32Array } {
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = amp * Math.cos((2 * Math.PI * bin * i) / n);
  return { re, im };
}

function magnitudes(re: Float32Array, im: Float32Array): number[] {
  return Array.from(re, (r, i) => Math.hypot(r, im[i]!));
}

describe('isPowerOfTwo', () => {
  it('accepts only positive powers of two', () => {
    for (const n of [1, 2, 4, 1024, 2048]) expect(isPowerOfTwo(n)).toBe(true);
    for (const n of [0, -2, 3, 6, 1000, 2.5, NaN, Infinity]) expect(isPowerOfTwo(n)).toBe(false);
  });
});

describe('fftInPlace', () => {
  it('puts a cosine\'s energy in its own bin (and its mirror)', () => {
    const n = 64;
    const { re, im } = cosBin(n, 7);
    fftInPlace(re, im);
    const mag = magnitudes(re, im);

    // A real cosine of amplitude 1 splits into n/2 at bin k and n/2 at n-k.
    expect(mag[7]!).toBeCloseTo(n / 2, 3);
    expect(mag[n - 7]!).toBeCloseTo(n / 2, 3);
    // Everything else is numerically zero.
    for (let b = 0; b < n; b++) {
      if (b === 7 || b === n - 7) continue;
      expect(mag[b]!).toBeLessThan(1e-3);
    }
  });

  it('round-trips: inverse(forward(x)) === x', () => {
    const n = 256;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.31) * 0.7 + Math.sin(i * 1.9) * 0.2;
      im[i] = 0;
    }
    const srcRe = re.slice();

    fftInPlace(re, im);
    fftInPlace(re, im, true);

    for (let i = 0; i < n; i++) {
      expect(re[i]!).toBeCloseTo(srcRe[i]!, 4);
      expect(Math.abs(im[i]!)).toBeLessThan(1e-4);
    }
  });

  it('is linear — the transform of a sum is the sum of the transforms', () => {
    const n = 128;
    const a = cosBin(n, 5, 0.4);
    const b = cosBin(n, 21, 0.6);
    const sum = { re: new Float32Array(n), im: new Float32Array(n) };
    for (let i = 0; i < n; i++) sum.re[i] = a.re[i]! + b.re[i]!;

    fftInPlace(a.re, a.im);
    fftInPlace(b.re, b.im);
    fftInPlace(sum.re, sum.im);

    for (let i = 0; i < n; i++) expect(sum.re[i]!).toBeCloseTo(a.re[i]! + b.re[i]!, 3);
  });

  // The module keeps time-stretch.md REQ-6's "nothing throws" contract, because
  // every caller is reached from a user-supplied buffer.
  it('is a no-op on a non-power-of-two length', () => {
    const re = new Float32Array([1, 2, 3]);
    const im = new Float32Array(3);
    expect(() => fftInPlace(re, im)).not.toThrow();
    expect(Array.from(re)).toEqual([1, 2, 3]);
  });

  it('is a no-op on mismatched channel lengths', () => {
    const re = new Float32Array([1, 2, 3, 4]);
    const im = new Float32Array(8);
    fftInPlace(re, im);
    expect(Array.from(re)).toEqual([1, 2, 3, 4]);
  });
});
