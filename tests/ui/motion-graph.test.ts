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
    const empty = { line: [], dots: [], carry: [] };
    expect(motionGraphPoints(bank({}), 'y', 'step')).toEqual(empty);
    expect(motionGraphPoints(bank({}), 'y', 'slide')).toEqual(empty);
  });

  describe('bar-line carry (REQ-2b, v3)', () => {
    const b = bank({ 2: { x: 0.25, y: 1 }, 10: { x: 0.75, y: 0 } });

    it('slide mode dashes both bar edges, tracing the self-wrap by default', () => {
      const { carry } = motionGraphPoints(b, 'y', 'slide');
      // Wrap 10 → 2 spans 8 steps; the bar line sits 6 of them along, so the
      // edges meet at 6/8 of the way from y=100 (value 0) up to y=0 (value 1).
      expect(carry).toEqual([
        [[0, 25], [cx(2), 0]],     // carried in: the wrap's tail
        [[cx(10), 100], [100, 25]], // carried out: the wrap's head
      ]);
    });

    it('ramps toward the NEXT bank instead when the chain moves on', () => {
      const next = bank({ 0: { x: 0.5, y: 1 } });
      const [, out] = motionGraphPoints(b, 'y', 'slide', { next }).carry;
      // 10 → next's step 0 spans 6 steps, all of them before the bar line, so the
      // edge lands on the next bank's opening value (y=1 → the top).
      expect(out).toEqual([[cx(10), 100], [100, 0]]);
    });

    it('holds flat at an edge that carries nowhere', () => {
      const { carry } = motionGraphPoints(b, 'y', 'slide', { prev: null, next: null });
      expect(carry).toEqual([
        [[0, 0], [cx(2), 0]],        // holds anchor 2's value back to the bar start
        [[cx(10), 100], [100, 100]], // holds anchor 10's value to the bar end
      ]);
    });

    it("step mode's lead-in follows the previous bank, and needs no dashes", () => {
      const prev = bank({ 6: { x: 0.5, y: 0.4 } });
      const { line, carry } = motionGraphPoints(b, 'y', 'step', { prev });
      expect(line[0]).toEqual([0, 60]); // the previous bar's last anchor, not this bank's
      expect(carry).toEqual([]);        // the staircase already spans the bar
    });
  });

  describe("drawn on the lane's cells, not the bank's 16 (v16, REQ-24b)", () => {
    /** Anchor-centre x for a lane of `cells` columns. */
    const cxOf = (s: number, cells: number): number => ((s + 0.5) / cells) * 100;
    /** Gankogui's shape: a home anchor, a raised one, home again. */
    const swept = bank({
      0: { x: 0.5, y: 0.4 }, 4: { x: 0.5, y: 0.75 }, 8: { x: 0.5, y: 0.4 },
    });

    it('puts every anchor over its own pad', () => {
      const { dots } = motionGraphPoints(swept, 'y', 'step', {}, 9);
      expect(dots).toEqual([[cxOf(0, 9), 60], [cxOf(4, 9), 25], [cxOf(8, 9), 60]]);
    });

    it('jumps where the pad is, not where 16 cells would have put it (regression)', () => {
      const { line } = motionGraphPoints(swept, 'y', 'step', {}, 9);
      // The bug: at a fixed 16 the step-4 anchor drew its edge at 28.125% —
      // inside cell 3 of a nine-column grid, with no pad dot to explain it.
      expect(line).toContainEqual([cxOf(4, 9), 25]);
      expect(line.some(([px]) => px === cxOf(4, 16))).toBe(false);
    });

    it('does not draw an anchor the lane is too short to reach', () => {
      // Cell 8 is past a 6-cell lane, so the curve cannot see it (REQ-24) and
      // neither can the graph — the line ends holding cell 4's value.
      const { dots, line } = motionGraphPoints(swept, 'y', 'step', {}, 6);
      expect(dots).toEqual([[cxOf(0, 6), 60], [cxOf(4, 6), 25]]);
      expect(line[line.length - 1]).toEqual([100, 25]);
    });

    it('samples the bar edges at the lane seam, not the bank end', () => {
      // Slide, self-wrapping: the wrap runs cell 4 → cell 2 the long way round,
      // which over SIX cells is 4 long and the bar start sits 2 of them in — so
      // the carried-in edge is halfway. Over sixteen it would be 6/7 of the way.
      const b = bank({ 2: { x: 0.5, y: 1 }, 4: { x: 0.5, y: 0 } });
      const { carry } = motionGraphPoints(b, 'y', 'slide', {}, 6);
      expect(carry[0]).toEqual([[0, 50], [cxOf(2, 6), 0]]);
    });

    it('omitting cells — or overshooting it — still spans the whole bank', () => {
      const full = motionGraphPoints(swept, 'y', 'step');
      expect(motionGraphPoints(swept, 'y', 'step', {}, 16)).toEqual(full);
      expect(motionGraphPoints(swept, 'y', 'step', {}, 99)).toEqual(full);
    });
  });
});
