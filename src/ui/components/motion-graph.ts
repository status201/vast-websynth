import type { MotionStep } from '../../state/patterns';
import { valueAt, type MotionMode, type MotionNeighbours } from '../../audio/transport/motion-curve';

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
 *     semantics: before the first anchor the value carried in over the bar line
 *     holds, each anchor jumps vertically at its dot and holds to the next; a
 *     single anchor is a flat line across the bar.
 *
 * `carry` holds the up-to-two segments joining the outer anchors to the bar edges
 * (the panel strokes them dashed): what the curve does *across* the bar line, which
 * depends on the neighbouring bars' banks (REQ-2b). Their edge values come from
 * `valueAt` itself, so the drawing cannot drift from what plays.
 */
export interface MotionGraph {
  line: Array<[number, number]>;
  dots: Array<[number, number]>;
  carry: Array<Array<[number, number]>>;
}

export function motionGraphPoints(
  bank: readonly MotionStep[],
  view: 'x' | 'y',
  mode: MotionMode,
  neighbours: MotionNeighbours = {},
): MotionGraph {
  const n = bank.length;
  const dots: Array<[number, number]> = [];
  for (let s = 0; s < n; s++) {
    const step = bank[s]!;
    if (!step.on) continue;
    dots.push([((s + 0.5) / n) * 100, (1 - step[view]) * 100]);
  }
  if (dots.length === 0) return { line: [], dots, carry: [] };

  // The values the curve holds at the two bar edges — the carry in and out. The
  // trailing edge is sampled a sliver before the bar line (`barPos` 1 wraps back
  // to 0), so round the float dust off the coordinate it produces.
  const edge = (barPos: number): number => {
    const v = valueAt(bank, barPos, mode, neighbours)!;
    return Math.round((1 - v[view]) * 1e6) / 1e4;
  };
  const yIn = edge(0);
  const yOut = edge((n - 1e-6) / n);

  if (mode === 'slide') {
    // Both edges are always drawn: a *flat* carry is itself the message — "this
    // value holds across the bar line", e.g. into an anchorless next bank.
    const carry: Array<Array<[number, number]>> = [
      [[0, yIn], dots[0]!],
      [dots[dots.length - 1]!, [100, yOut]],
    ];
    return { line: dots.slice(), dots, carry };
  }

  // Step mode: staircase through the dots, jumping at each dot's x so every
  // dot sits on the line. The carried-in value leads in from 0.
  const line: Array<[number, number]> = [[0, yIn]];
  let prevY = yIn;
  for (const [cx, cy] of dots) {
    line.push([cx, prevY], [cx, cy]);
    prevY = cy;
  }
  line.push([100, prevY]);
  // The staircase already spans the bar; its lead-in *is* the carry and is part
  // of the line, so there is nothing extra to dash.
  return { line, dots, carry: [] };
}
