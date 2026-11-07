import { describe, it, expect } from 'vitest';
import { FIT_TARGETS, fitLabel, nearestTarget } from '../../src/state/fit-targets';
import { MAX_SCRATCH_STEPS } from '../../src/state/limits';

describe('fit targets (time-stretch.md REQ-the-fit-row-preselects-the-nearest-target)', () => {
  it('offers every step count to two bars, then 48 and the scratch ceiling', () => {
    expect(FIT_TARGETS.slice(0, 32)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    expect(FIT_TARGETS.slice(32)).toEqual([48, MAX_SCRATCH_STEPS]);
  });

  it('labels a round number of bars, and halves and quarters, against the meter', () => {
    expect(fitLabel(16, 16)).toBe('16 · 1 bar');
    expect(fitLabel(32, 16)).toBe('32 · 2 bars');
    expect(fitLabel(8, 16)).toBe('8 · ½ bar');
    expect(fitLabel(4, 16)).toBe('4 · ¼ bar');
    expect(fitLabel(5, 16)).toBe('5');
    expect(fitLabel(12, 12)).toBe('12 · 1 bar'); // a 3/4 bar is twelve sixteenths
  });

  it('preselects the target closest to the selection, the shorter on a tie', () => {
    const framesFor = (steps: number): number => steps * 1000;
    expect(nearestTarget(16_200, framesFor)).toBe(16);
    expect(nearestTarget(16_500, framesFor)).toBe(16); // equidistant from 16 and 17
    expect(nearestTarget(1_000_000, framesFor)).toBe(MAX_SCRATCH_STEPS);
  });
});
