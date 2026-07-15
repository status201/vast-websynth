import type { MotionStep } from '../../state/patterns';
import type { MotionMode } from '../../audio/transport/motion-curve';

/**
 * Pure geometry for the Motion panel's axis-graph overlay
 * (motion-sequencer.md REQ-8) — no DOM, so it is unit-testable like
 * `motion-curve.ts`. Coordinates are in the graph SVG's 0–100 viewBox space,
 * y-down (an anchor value of 1 draws at y=0).
 *
 * Dots always sit at the anchor centres. The line is mode-aware:
 *   - 'slide' — the anchor-to-anchor polyline (the panel only strokes it when
 *     there are ≥ 2 points, matching the machine's constant-value single-anchor
 *     case).
 *   - 'step'  — a full-width staircase mirroring `valueAt`'s jump-and-hold
 *     semantics: before the first anchor the *last* anchor's value holds (the
 *     bar-loop wrap), each anchor jumps vertically at its dot and holds to the
 *     next; a single anchor is a flat line across the bar.
 */
export interface MotionGraph {
  line: Array<[number, number]>;
  dots: Array<[number, number]>;
}

export function motionGraphPoints(
  bank: readonly MotionStep[],
  view: 'x' | 'y',
  mode: MotionMode,
): MotionGraph {
  const n = bank.length;
  const dots: Array<[number, number]> = [];
  for (let s = 0; s < n; s++) {
    const step = bank[s]!;
    if (!step.on) continue;
    dots.push([((s + 0.5) / n) * 100, (1 - step[view]) * 100]);
  }
  if (mode === 'slide' || dots.length === 0) return { line: dots.slice(), dots };

  // Step mode: staircase through the dots, jumping at each dot's x so every
  // dot sits on the line. The wrap hold (last anchor's value) leads in from 0.
  const yLast = dots[dots.length - 1]![1];
  const line: Array<[number, number]> = [[0, yLast]];
  let prevY = yLast;
  for (const [cx, cy] of dots) {
    line.push([cx, prevY], [cx, cy]);
    prevY = cy;
  }
  line.push([100, prevY]);
  return { line, dots };
}
