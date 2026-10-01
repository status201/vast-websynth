// scope.md REQ-the-wave-trace-is-triggered — the Wave view starts each frame at the
// same point of the cycle, so a steady tone stands still.
import { describe, it, expect } from 'vitest';
import { findRisingZeroCrossing } from '../../src/ui/components/scope';

/** `n` samples of a sine with `period` samples per cycle, starting at `phase` radians. */
function sine(n: number, period: number, phase: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(phase + (2 * Math.PI * i) / period);
  return a;
}

describe('findRisingZeroCrossing', () => {
  it('finds the first upward crossing, whatever the phase the buffer starts at', () => {
    for (const phase of [0.3, 1.5, 2.9, 4.0, 5.5]) {
      const data = sine(1024, 64, phase);
      const i = findRisingZeroCrossing(data, 256);
      expect(i).toBeGreaterThan(0);
      expect(data[i - 1]!).toBeLessThan(0);
      expect(data[i]!).toBeGreaterThanOrEqual(0);
      // Same point of the cycle every time: a quarter period past the rising zero is the crest.
      expect(data[i + 16]!).toBeGreaterThan(0.9);
    }
  });

  it('ignores a downward crossing', () => {
    const data = new Float32Array([0.5, 0.2, -0.2, -0.5, -0.1, 0.3]);
    expect(findRisingZeroCrossing(data, 5)).toBe(5);
  });

  it('returns -1 for silence and for a period longer than the search', () => {
    expect(findRisingZeroCrossing(new Float32Array(1024), 256)).toBe(-1);
    const slow = sine(1024, 2048, 0.1);   // rising through the whole search window
    expect(findRisingZeroCrossing(slow, 256)).toBe(-1);
  });

  it('never reads past the buffer', () => {
    const data = new Float32Array([-1, 1]);
    expect(findRisingZeroCrossing(data, 99)).toBe(1);
  });
});
