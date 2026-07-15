import { describe, it, expect } from 'vitest';
import { anchorIndices, valueAt } from '../../../src/audio/transport/motion-curve';
import { makeMotionBank, SEQ_LENGTH, type MotionStep } from '../../../src/state/patterns';

/** A bank with anchors at the given steps ({step: [x, y]}). */
function bank(anchors: Record<number, [number, number]>): MotionStep[] {
  const b = makeMotionBank();
  for (const [step, [x, y]] of Object.entries(anchors)) {
    Object.assign(b[Number(step)]!, { on: true, x, y });
  }
  return b;
}

/** Position of step `s` as a bar fraction. */
const at = (s: number): number => s / SEQ_LENGTH;

describe('motion-curve', () => {
  it('anchorIndices lists ON steps ascending', () => {
    expect(anchorIndices(bank({}))).toEqual([]);
    expect(anchorIndices(bank({ 8: [0, 0], 0: [0, 0], 15: [0, 0] }))).toEqual([0, 8, 15]);
  });

  it('an empty bank evaluates to null (no automation)', () => {
    expect(valueAt(bank({}), 0, 'slide')).toBeNull();
    expect(valueAt(bank({}), 0.5, 'step')).toBeNull();
  });

  it('a single anchor holds its value everywhere, both modes', () => {
    const b = bank({ 4: [0.25, 0.75] });
    for (const pos of [0, at(4), at(12), 0.999]) {
      expect(valueAt(b, pos, 'slide')).toEqual({ x: 0.25, y: 0.75 });
      expect(valueAt(b, pos, 'step')).toEqual({ x: 0.25, y: 0.75 });
    }
  });

  describe('step mode', () => {
    const b = bank({ 0: [0.1, 0.2], 8: [0.9, 1] });

    it('jumps at each anchor and holds until the next', () => {
      expect(valueAt(b, at(0), 'step')).toEqual({ x: 0.1, y: 0.2 });
      expect(valueAt(b, at(7.9), 'step')).toEqual({ x: 0.1, y: 0.2 });
      expect(valueAt(b, at(8), 'step')).toEqual({ x: 0.9, y: 1 });
      expect(valueAt(b, at(15.9), 'step')).toEqual({ x: 0.9, y: 1 });
    });

    it('before the first anchor the LAST anchor holds (the loop carry-over)', () => {
      const late = bank({ 4: [0.3, 0.3], 12: [0.6, 0.6] });
      expect(valueAt(late, at(1), 'step')).toEqual({ x: 0.6, y: 0.6 });
    });
  });

  describe('slide mode', () => {
    it('ramps linearly between anchors, across unset gaps', () => {
      // The user's sweep example: min at step 0, max at step 8, min at step 15.
      const b = bank({ 0: [0.5, 0], 8: [0.5, 1], 15: [0.5, 0] });
      expect(valueAt(b, at(0), 'slide')).toEqual({ x: 0.5, y: 0 });
      expect(valueAt(b, at(4), 'slide')!.y).toBeCloseTo(0.5, 10);
      expect(valueAt(b, at(8), 'slide')).toEqual({ x: 0.5, y: 1 });
      // Descending leg: 8 → 15 spans 7 steps.
      expect(valueAt(b, at(11.5), 'slide')!.y).toBeCloseTo(0.5, 10);
      expect(valueAt(b, at(15), 'slide')!.y).toBeCloseTo(0, 10);
    });

    it('interpolates both axes independently', () => {
      const b = bank({ 0: [0, 1], 8: [1, 0] });
      const mid = valueAt(b, at(4), 'slide')!;
      expect(mid.x).toBeCloseTo(0.5, 10);
      expect(mid.y).toBeCloseTo(0.5, 10);
    });

    it('wraps last→first anchor over the bar boundary', () => {
      const b = bank({ 4: [0, 0], 12: [0, 1] });
      // After step 12 the curve heads back to the step-4 anchor: span 8 steps
      // (12→16 wraps →4). Halfway (step 0 of the next pass) = y 0.5.
      expect(valueAt(b, at(0), 'slide')!.y).toBeCloseTo(0.5, 10);
      // Before the first anchor we are inside the same wrapped segment.
      expect(valueAt(b, at(2), 'slide')!.y).toBeCloseTo(0.25, 10);
    });

    it('adjacent anchors make a hard step within one slot', () => {
      const b = bank({ 7: [0, 0], 8: [0, 1] });
      expect(valueAt(b, at(7), 'slide')!.y).toBeCloseTo(0, 10);
      expect(valueAt(b, at(7.5), 'slide')!.y).toBeCloseTo(0.5, 10);
      expect(valueAt(b, at(8), 'slide')!.y).toBeCloseTo(1, 10);
    });
  });

  it('out-of-range positions wrap into the bar', () => {
    const b = bank({ 0: [0.2, 0.2], 8: [0.8, 0.8] });
    expect(valueAt(b, 1.5, 'step')).toEqual(valueAt(b, 0.5, 'step'));
    expect(valueAt(b, -0.25, 'slide')!.y).toBeCloseTo(valueAt(b, 0.75, 'slide')!.y, 10);
  });
});
