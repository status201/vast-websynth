import type { MotionStep, MotionTrackStep } from '../../state/patterns';
import {
  scalarAt, type MotionMode, type MotionNeighbours, type MotionTrackNeighbours, type Neighbours,
} from '../../audio/transport/motion-curve';

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
 * `scalarAt` itself, so the drawing cannot drift from what plays.
 *
 * (v4) The geometry is generic over "a lane of anchorable cells plus a value
 * accessor", exactly like the curve core it samples — so the XY row's two axes
 * and an extra single-param track (`motionGraphPoints1D`) draw through one
 * implementation.
 */
export interface MotionGraph {
  line: Array<[number, number]>;
  dots: Array<[number, number]>;
  carry: Array<Array<[number, number]>>;
}

function graphPoints<T extends { on: boolean }>(
  bank: readonly T[],
  get: (s: T) => number,
  mode: MotionMode,
  neighbours: Neighbours<T>,
): MotionGraph {
  const n = bank.length;
  const dots: Array<[number, number]> = [];
  for (let s = 0; s < n; s++) {
    const step = bank[s]!;
    if (!step.on) continue;
    dots.push([((s + 0.5) / n) * 100, (1 - get(step)) * 100]);
  }
  if (dots.length === 0) return { line: [], dots, carry: [] };

  // The values the curve holds at the two bar edges — the carry in and out. The
  // trailing edge is sampled a sliver before the bar line (`barPos` 1 wraps back
  // to 0), so round the float dust off the coordinate it produces.
  const edge = (barPos: number): number => {
    const v = scalarAt(bank, barPos, mode, get, neighbours)!;
    return Math.round((1 - v) * 1e6) / 1e4;
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

const getX = (s: MotionStep): number => s.x;
const getY = (s: MotionStep): number => s.y;

/** The XY row's graph, projected onto one axis (REQ-8). */
export function motionGraphPoints(
  bank: readonly MotionStep[],
  view: 'x' | 'y',
  mode: MotionMode,
  neighbours: MotionNeighbours = {},
): MotionGraph {
  return graphPoints(bank, view === 'x' ? getX : getY, mode, neighbours);
}

/** An extra single-param track's graph (REQ-16). */
export function motionGraphPoints1D(
  steps: readonly MotionTrackStep[],
  mode: MotionMode,
  neighbours: MotionTrackNeighbours = {},
): MotionGraph {
  return graphPoints(steps, (s) => s.v, mode, neighbours);
}
