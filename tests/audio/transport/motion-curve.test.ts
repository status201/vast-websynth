import { describe, it, expect } from 'vitest';
import { anchorIndices, valueAt, valueAt1D } from '../../../src/audio/transport/motion-curve';
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

  describe('cross-bank carry (REQ-2b)', () => {
    // The reported bug, distilled: bank D ramps a delay up and ends high, bank A
    // opens on that value and fades down. Pre-v3 each bank's final step raced back
    // to its OWN first anchor, so D's throw collapsed at the seam and A's low
    // ending sprang back up (and then froze through anchorless banks).
    const d = bank({ 0: [0, 0.13], 10: [0, 0.13], 14: [0, 0.58], 15: [0, 0.53] });
    const a = bank({ 0: [0, 0.55], 7: [0, 0.52], 13: [0, 0.16], 15: [0, 0.13] });

    it('ramps toward the next bank instead of back to its own first anchor', () => {
      // Last anchor 15 → A's anchor 0: span 1 step, so the whole final 16th is
      // the hand-over — it must climb toward 0.55, never dive to D's own 0.13.
      expect(valueAt(d, at(15.5), 'slide', { next: a })!.y).toBeCloseTo(0.54, 10);
      expect(valueAt(d, at(15.99), 'slide', { next: a })!.y).toBeCloseTo(0.5498, 4);
      // Pre-v3 (no neighbours) the same position had already collapsed.
      expect(valueAt(d, at(15.5), 'slide')!.y).toBeCloseTo(0.33, 10);
    });

    it('continues the same segment on the other side of the bar line', () => {
      // A opens exactly on its own anchor 0 — the carry-in segment has zero
      // length here because that anchor sits on step 0.
      expect(valueAt(a, at(0), 'slide', { prev: d })!.y).toBeCloseTo(0.55, 10);
      // With a later first anchor the lead-in continues D's ramp across the line.
      const late = bank({ 4: [0, 0.15], 12: [0, 0.35] });
      // D's last anchor (step 15, 0.53) → late's step 4: span 5, 1 step consumed
      // by D's own bar, so step 0 of this bar is 1/5 of the way along.
      expect(valueAt(late, at(0), 'slide', { prev: d })!.y).toBeCloseTo(0.53 + (0.15 - 0.53) / 5, 10);
      expect(valueAt(late, at(2), 'slide', { prev: d })!.y).toBeCloseTo(0.53 + (0.15 - 0.53) * 0.6, 10);
    });

    it('holds flat when the neighbour rests, is empty, or is unusable (null)', () => {
      for (const nb of [{ next: null }, { next: bank({}) }]) {
        expect(valueAt(a, at(15.5), 'slide', nb)!.y).toBeCloseTo(0.13, 10); // A's last anchor
        expect(valueAt(a, at(15.99), 'slide', nb)!.y).toBeCloseTo(0.13, 10);
      }
      const late = bank({ 4: [0, 0.15], 12: [0, 0.35] });
      expect(valueAt(late, at(0), 'slide', { prev: null })!.y).toBeCloseTo(0.15, 10);
      expect(valueAt(late, at(1), 'step', { prev: null })!.y).toBeCloseTo(0.15, 10);
    });

    it('carries the previous bank in step mode too', () => {
      const late = bank({ 4: [0, 0.15], 12: [0, 0.35] });
      expect(valueAt(late, at(1), 'step', { prev: d })!.y).toBeCloseTo(0.53, 10);
      expect(valueAt(late, at(1), 'step')!.y).toBeCloseTo(0.35, 10); // pre-v3: own last anchor
    });

    it('same-bank neighbours reproduce the pre-v3 self-wrap exactly', () => {
      const b = bank({ 4: [0, 0], 12: [0, 1] });
      for (const p of [0, at(2), at(4), at(8), at(12), at(14), at(15.5)]) {
        for (const mode of ['slide', 'step'] as const) {
          expect(valueAt(b, p, mode, { prev: b, next: b })).toEqual(valueAt(b, p, mode));
        }
      }
      // Including the single-anchor case, which no longer short-circuits.
      const one = bank({ 6: [0.25, 0.75] });
      expect(valueAt(one, at(1), 'slide', { prev: one, next: one })).toEqual({ x: 0.25, y: 0.75 });
    });
  });

  it('out-of-range positions wrap into the bar', () => {
    const b = bank({ 0: [0.2, 0.2], 8: [0.8, 0.8] });
    expect(valueAt(b, 1.5, 'step')).toEqual(valueAt(b, 0.5, 'step'));
    expect(valueAt(b, -0.25, 'slide')!.y).toBeCloseTo(valueAt(b, 0.75, 'slide')!.y, 10);
  });
});

describe('valueAt1D — extra single-param tracks (motion-sequencer.md REQ-14)', () => {
  const t = (anchors: Record<number, number>): { on: boolean; v: number }[] =>
    Array.from({ length: 16 }, (_, i) => (
      i in anchors ? { on: true, v: anchors[i]! } : { on: false, v: 0.5 }
    ));

  it('a track with no anchors writes nothing', () => {
    expect(valueAt1D(t({}), 0.5, 'slide')).toBeNull();
  });

  it('slides linearly between anchors', () => {
    const steps = t({ 0: 0, 8: 1 });
    expect(valueAt1D(steps, 0, 'slide')).toBeCloseTo(0, 6);
    expect(valueAt1D(steps, 4 / 16, 'slide')).toBeCloseTo(0.5, 6);
    expect(valueAt1D(steps, 8 / 16, 'slide')).toBeCloseTo(1, 6);
  });

  it('step mode jumps and holds', () => {
    const steps = t({ 0: 0.2, 8: 0.9 });
    expect(valueAt1D(steps, 4 / 16, 'step')).toBeCloseTo(0.2, 6);
    expect(valueAt1D(steps, 8 / 16, 'step')).toBeCloseTo(0.9, 6);
    expect(valueAt1D(steps, 15 / 16, 'step')).toBeCloseTo(0.9, 6);
  });

  it('carries across the bar line into the next bar’s track', () => {
    const a = t({ 0: 0, 15: 1 });
    const b = t({ 0: 0 });
    // After the last anchor it heads for b's first anchor (1 → 0), not back to
    // its own step-0 value — the REQ-2b carry, inherited from the shared core.
    const mid = valueAt1D(a, 15.5 / 16, 'slide', { next: b });
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('holds flat toward an unusable neighbour', () => {
    const a = t({ 0: 0, 15: 1 });
    expect(valueAt1D(a, 15.5 / 16, 'slide', { next: null })).toBeCloseTo(1, 6);
    expect(valueAt1D(a, 15.5 / 16, 'slide', { next: t({}) })).toBeCloseTo(1, 6);
  });

  it('matches the XY lane exactly — both go through the same scalar core', () => {
    // Same anchor positions and values on a track and on the XY lane's y axis
    // must produce identical curves at every sample point.
    const track = t({ 2: 0.25, 9: 0.8 });
    const xyBank = Array.from({ length: 16 }, (_, i) => (
      i === 2 ? { on: true, x: 0, y: 0.25 }
        : i === 9 ? { on: true, x: 0, y: 0.8 }
          : { on: false, x: 0, y: 0.5 }
    ));
    for (const mode of ['slide', 'step'] as const) {
      for (let p = 0; p < 16; p += 0.25) {
        expect(valueAt1D(track, p / 16, mode)).toBeCloseTo(valueAt(xyBank, p / 16, mode)!.y, 9);
      }
    }
  });
});
