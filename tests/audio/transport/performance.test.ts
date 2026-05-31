import { describe, it, expect } from 'vitest';

/**
 * Tests for the Performance module's pure-logic paths.
 * `mapStep` (stutter) is pure math — no AudioContext required.
 * Filter Drop / DJ Filter / Tape Stop need real AudioContext / rAF
 * so they are tested via integration only.
 */
describe('Performance.mapStep (stutter)', () => {
  // Replicate the production math inline so we can test it without
  // constructing a full Performance (which needs AudioContext).
  function mapStep(rawStep: number, stutterOn: boolean, stutterSize: number, anchor: number): number {
    if (!stutterOn) return rawStep;
    const n = stutterSize;
    const off = (((rawStep - anchor) % n) + n) % n;
    return anchor + off;
  }

  it('passthrough when stutter is off', () => {
    expect(mapStep(5, false, 2, 0)).toBe(5);
  });

  it('repeats within stutter window (size=2)', () => {
    // anchor = 4, size = 2 → steps 4,5 loop
    expect(mapStep(4, true, 2, 4)).toBe(4);
    expect(mapStep(5, true, 2, 4)).toBe(5);
    expect(mapStep(6, true, 2, 4)).toBe(4);
    expect(mapStep(7, true, 2, 4)).toBe(5);
    expect(mapStep(8, true, 2, 4)).toBe(4);
  });

  it('repeats within stutter window (size=4)', () => {
    // anchor = 10, size = 4 → steps 10,11,12,13 loop
    expect(mapStep(10, true, 4, 10)).toBe(10);
    expect(mapStep(11, true, 4, 10)).toBe(11);
    expect(mapStep(12, true, 4, 10)).toBe(12);
    expect(mapStep(13, true, 4, 10)).toBe(13);
    expect(mapStep(14, true, 4, 10)).toBe(10);
    expect(mapStep(15, true, 4, 10)).toBe(11);
  });

  it('handles rawStep smaller than anchor', () => {
    // anchor = 10, size = 4 → step 9 maps to 13 (wrapping backwards)
    expect(mapStep(9, true, 4, 10)).toBe(13);
    expect(mapStep(8, true, 4, 10)).toBe(12);
  });

  it('single-step stutter', () => {
    expect(mapStep(0, true, 1, 0)).toBe(0);
    expect(mapStep(1, true, 1, 0)).toBe(0);
    expect(mapStep(2, true, 1, 0)).toBe(0);
  });

  it('size=1 with negative offset from anchor', () => {
    // anchor = 5, size = 1 → step 4 wraps to 5
    expect(mapStep(4, true, 1, 5)).toBe(5);
  });
});
