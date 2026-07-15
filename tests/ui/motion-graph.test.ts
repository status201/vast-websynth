import { describe, it, expect } from 'vitest';
import { motionGraphPoints } from '../../src/ui/components/motion-graph';
import type { MotionStep } from '../../src/state/patterns';

/** A 16-step bank with anchors at the given steps (x = y = value). */
function bank(anchors: Record<number, { x: number; y: number }>): MotionStep[] {
  return Array.from({ length: 16 }, (_, s) => {
    const a = anchors[s];
    return a ? { on: true, x: a.x, y: a.y } : { on: false, x: 0.5, y: 0.5 };
  });
}

/** Anchor-centre x in viewBox space. */
const cx = (s: number): number => ((s + 0.5) / 16) * 100;

describe('motionGraphPoints (motion-sequencer.md REQ-8)', () => {
  it('slide mode returns the plain anchor polyline', () => {
    const b = bank({ 2: { x: 0.25, y: 1 }, 10: { x: 0.75, y: 0 } });
    const { line, dots } = motionGraphPoints(b, 'y', 'slide');
    expect(dots).toEqual([[cx(2), 0], [cx(10), 100]]); // y=1 draws at the top
    expect(line).toEqual(dots);
  });

  it('step mode draws a full-width staircase with the last→first wrap hold', () => {
    const b = bank({ 2: { x: 0.25, y: 1 }, 10: { x: 0.75, y: 0 } });
    const { line, dots } = motionGraphPoints(b, 'y', 'step');
    expect(dots).toEqual([[cx(2), 0], [cx(10), 100]]);
    expect(line).toEqual([
      [0, 100],          // bar start holds the LAST anchor's value (wrap)
      [cx(2), 100], [cx(2), 0],   // jump at anchor 2
      [cx(10), 0], [cx(10), 100], // hold, jump at anchor 10
      [100, 100],        // hold to the bar end
    ]);
  });

  it('projects the selected axis (x view uses step.x)', () => {
    const b = bank({ 2: { x: 0.25, y: 1 }, 10: { x: 0.75, y: 0 } });
    const { dots } = motionGraphPoints(b, 'x', 'step');
    expect(dots).toEqual([[cx(2), 75], [cx(10), 25]]);
  });

  it('a single anchor in step mode is a flat full-width line', () => {
    const b = bank({ 5: { x: 0.5, y: 0.4 } });
    const { line, dots } = motionGraphPoints(b, 'y', 'step');
    expect(dots).toEqual([[cx(5), 60]]);
    expect(line[0]).toEqual([0, 60]);
    expect(line[line.length - 1]).toEqual([100, 60]);
    expect(line.every(([, py]) => py === 60)).toBe(true);
  });

  it('an empty bank draws nothing in either mode', () => {
    expect(motionGraphPoints(bank({}), 'y', 'step')).toEqual({ line: [], dots: [] });
    expect(motionGraphPoints(bank({}), 'y', 'slide')).toEqual({ line: [], dots: [] });
  });
});
