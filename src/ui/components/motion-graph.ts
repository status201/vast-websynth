import type { MotionStep, MotionTrackStep } from '../../state/patterns';
import {
  scalarAt, type MotionMode, type MotionNeighbours, type MotionTrackNeighbours, type Neighbours,
} from '../../audio/transport/motion-curve';

/**
 * Pure geometry for the Motion panel's axis-graph overlay
 * (motion-panel.md REQ-each-motion-step-is-a-mini-xy-pad) — no DOM, so it is unit-testable like
 * `motion-curve.ts`. Coordinates are in the graph SVG's 0–100 viewBox space,
 * y-down (an anchor value of 1 draws at y=0).
 *
 * Dots always sit at the anchor centres — geometry, not the visible anchor
 * marker: the panel marks each with a short level segment on the line (a circle
 * would be flattened by the overlay's non-uniform viewBox), and the round dot a
 * reader sees at an XY anchor belongs to the pad underneath (motion-panel.md REQ-each-motion-step-is-a-mini-xy-pad). The line is
 * mode-aware:
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
 * depends on the neighbouring bars' banks (REQ-cross-bank-carry). Their edge values come from
 * `scalarAt` itself, so the drawing cannot drift from what plays.
 *
 * (v4) The geometry is generic over "a lane of anchorable cells plus a value
 * accessor", exactly like the curve core it samples — so the XY row's two axes
 * and an extra single-param track (`motionGraphPoints1D`) draw through one
 * implementation.
 *
 * (v16) Every coordinate is a fraction of the **lane's** played length, not the
 * bank's 16 (motion-panel.md REQ-the-motion-graph-follows-the-lane). `cells` is the same argument
 * `scalarAt` takes and defaults the same way, so a caller with no meter is
 * unaffected — but the panel has one, and passing it is what keeps the drawing
 * on the grid the pads are drawn on. Before it existed a 9-cell lane squeezed
 * its whole curve into the left 9/16 of the row and every jump landed in the
 * wrong cell.
 */
export interface MotionGraph {
  line: Array<[number, number]>;
  dots: Array<[number, number]>;
  carry: Array<Array<[number, number]>>;
}

/** The lane's played length, clamped exactly as `scalarAt` clamps it, so the
 *  geometry and the curve agree on it for every input the panel can hand them. */
function laneLength(bank: readonly unknown[], cells?: number): number {
  return cells === undefined ? bank.length : Math.max(1, Math.min(bank.length, cells));
}

function graphPoints<T extends { on: boolean }>(
  bank: readonly T[],
  get: (s: T) => number,
  mode: MotionMode,
  neighbours: Neighbours<T>,
  cells?: number,
): MotionGraph {
  const n = laneLength(bank, cells);
  const dots: Array<[number, number]> = [];
  // Anchors past the lane are skipped, not drawn off the right edge: the curve
  // cannot see them either (REQ-the-automation-lane-follows-the-meter), and their cells are dark.
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
    const v = scalarAt(bank, barPos, mode, get, neighbours, undefined, n)!;
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

/** The XY row's graph, projected onto one axis (REQ-each-motion-step-is-a-mini-xy-pad); `cells` per REQ-the-motion-graph-follows-the-lane. */
export function motionGraphPoints(
  bank: readonly MotionStep[],
  view: 'x' | 'y',
  mode: MotionMode,
  neighbours: MotionNeighbours = {},
  cells?: number,
): MotionGraph {
  return graphPoints(bank, view === 'x' ? getX : getY, mode, neighbours, cells);
}

/**
 * The level each cell of an extra track shows (motion-panel.md REQ-an-unset-level-cell-shows-the-curve):
 * its own value where it holds an anchor, otherwise the height of the drawn line
 * at the cell's centre — read off `motionGraphPoints1D`'s own geometry, carry
 * included, so a fill can only ever sit on the line above it. `null` past the
 * lane, and everywhere when the lane has no anchors (it writes nothing).
 */
export function motionLevels1D(
  steps: readonly MotionTrackStep[],
  mode: MotionMode,
  neighbours: MotionTrackNeighbours = {},
  cells?: number,
): Array<number | null> {
  const n = laneLength(steps, cells);
  const { line, carry } = motionGraphPoints1D(steps, mode, neighbours, cells);
  if (line.length === 0) return steps.map(() => null);
  // SLIDE strokes the anchors and the two dashed carries apart; STEP's
  // staircase already runs edge to edge.
  const path = mode === 'slide' ? [carry[0]![0]!, ...line, carry[1]![1]!] : line;
  return steps.map((step, s) => {
    if (s >= n) return null;
    return step.on ? step.v : heightAt(path, ((s + 0.5) / n) * 100);
  });
}

/** A path's value (0..1, up) at viewBox `x`; vertical segments (STEP's jumps) are skipped. */
function heightAt(path: ReadonlyArray<readonly [number, number]>, x: number): number {
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1]!;
    const [x1, y1] = path[i]!;
    if (x1 > x0 && x >= x0 && x <= x1) return 1 - (y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)) / 100;
  }
  return 1 - path[path.length - 1]![1] / 100;
}

/** An extra single-param track's graph (REQ-single-param-lanes-below-the-xy-lane). */
export function motionGraphPoints1D(
  steps: readonly MotionTrackStep[],
  mode: MotionMode,
  neighbours: MotionTrackNeighbours = {},
  cells?: number,
): MotionGraph {
  return graphPoints(steps, (s) => s.v, mode, neighbours, cells);
}
