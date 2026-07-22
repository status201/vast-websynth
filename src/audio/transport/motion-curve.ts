import type { MotionStep, MotionTrackStep } from '../../state/patterns';

/**
 * Pure motion-sequencer curve math (no AudioContext, like step-hits.ts).
 *
 * A motion bank's ON steps are *anchors*. `valueAt` evaluates the bank at a
 * fractional bar position:
 *   - 'step'  — the most recent anchor at/before the position holds its value
 *               (before the first anchor the value carried in over the bar line
 *               holds).
 *   - 'slide' — piecewise-linear between consecutive anchors, across unset gaps,
 *               and across the bar line itself.
 * A bank with no anchors evaluates to null (the machine writes nothing).
 * Coordinates stay in the 0..1 normalized taper space of the XY pad; mapping to
 * real param values happens in the machine via fromNorm.
 *
 * The segment spanning the bar line joins this bank's outer anchors to the
 * *neighbouring bars'* banks (motion-sequencer.md REQ-2b): out of the last anchor
 * toward `next`'s first, into the first anchor from `prev`'s last. Passing the same
 * bank (or nothing) gives the self-wrap a looping bank had before v3.
 *
 * (v4) All of that lives in ONE scalar routine, `scalarAt`, generic over any
 * `{ on }` cell plus a value accessor. The XY lane's `valueAt` is two calls of it
 * and an extra track's `valueAt1D` is one, so the two-axis pad and the
 * single-param tracks cannot drift apart (REQ-14).
 */

export type MotionMode = 'step' | 'slide';

export interface MotionXY {
  x: number;
  y: number;
}

/** Any anchorable cell: the `on` flag is what makes a step an anchor. */
interface Anchorable {
  on: boolean;
}

/**
 * The banks playing in the adjacent bars. Absent ⇒ `bank` itself (a looping
 * bank). `null` or anchorless ⇒ nothing to carry to/from, so the curve holds flat
 * at the bar line instead of ramping toward a meaningless target. Callers own the
 * *usability* rule (a resting bar, or one driving different params, passes null) —
 * this module stays pure curve math.
 */
export interface Neighbours<T> {
  prev?: readonly T[] | null;
  next?: readonly T[] | null;
}

export type MotionNeighbours = Neighbours<MotionStep>;
export type MotionTrackNeighbours = Neighbours<MotionTrackStep>;

/** Indices of the bank's ON steps, ascending. */
export function anchorIndices(bank: readonly Anchorable[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bank.length; i++) if (bank[i]!.on) out.push(i);
  return out;
}

/** An adjacent bar's anchors, or null when there is nothing to carry to/from. */
interface Carry<T> {
  bank: readonly T[];
  idx: number[];
}

/** Absent neighbour ⇒ `bank` itself (the looping-bank self-wrap); null or
 *  anchorless ⇒ no carry, so the caller holds its outer anchor flat. */
function carryFrom<T extends Anchorable>(
  neighbour: readonly T[] | null | undefined,
  bank: readonly T[],
): Carry<T> | null {
  const b = neighbour === undefined ? bank : neighbour;
  if (!b) return null;
  const idx = anchorIndices(b);
  return idx.length ? { bank: b, idx } : null;
}

/**
 * Evaluate one scalar lane at `barPos` ∈ [0, 1) (fraction of the bar; an anchor
 * at step i sits at position i / bank.length). Out-of-range positions wrap.
 * `get` reads the value off a cell, which is the only thing that differs between
 * the XY lane's two axes and an extra track.
 */
export function scalarAt<T extends Anchorable>(
  bank: readonly T[],
  barPos: number,
  mode: MotionMode,
  get: (s: T) => number,
  neighbours: Neighbours<T> = {},
): number | null {
  const idx = anchorIndices(bank);
  if (idx.length === 0) return null;

  const n = bank.length;
  const p = (((barPos % 1) + 1) % 1) * n; // position in step units, [0, n)
  const firstIdx = idx[0]!;
  const lastIdx = idx[idx.length - 1]!;

  // Last anchor at or before p (-1 when p precedes the first anchor).
  let prev = -1;
  for (const i of idx) {
    if (i <= p) prev = i;
    else break;
  }

  if (mode === 'step') {
    if (prev >= 0) return get(bank[prev]!);
    // Before the first anchor: whatever the previous bar left holds.
    const carry = carryFrom(neighbours.prev, bank);
    return get(carry ? carry.bank[carry.idx[carry.idx.length - 1]!]! : bank[firstIdx]!);
  }

  // Slide: find the surrounding segment a→b (the outer two span the bar line).
  let sa: T, sb: T;
  let span: number, dist: number;
  if (prev < 0) {
    // Before the first anchor: still inside the segment carried in from the
    // previous bar, which ends on this bank's first anchor.
    const carry = carryFrom(neighbours.prev, bank);
    if (!carry) return get(bank[firstIdx]!);
    const a = carry.idx[carry.idx.length - 1]!;
    sa = carry.bank[a]!;
    sb = bank[firstIdx]!;
    span = n - a + firstIdx;
    dist = p + n - a;
  } else if (prev === lastIdx) {
    // After the last anchor: head for the next bar's first anchor.
    const carry = carryFrom(neighbours.next, bank);
    if (!carry) return get(bank[lastIdx]!);
    const b = carry.idx[0]!;
    sa = bank[lastIdx]!;
    sb = carry.bank[b]!;
    span = n - lastIdx + b;
    dist = p - lastIdx;
  } else {
    const b = idx[idx.indexOf(prev) + 1]!;
    sa = bank[prev]!;
    sb = bank[b]!;
    span = b - prev;
    dist = p - prev;
  }
  const t = span > 0 ? Math.min(1, Math.max(0, dist / span)) : 0;
  const va = get(sa);
  return va + (get(sb) - va) * t;
}

const getX = (s: MotionStep): number => s.x;
const getY = (s: MotionStep): number => s.y;
const getV = (s: MotionTrackStep): number => s.v;

/**
 * The XY lane. Both axes share one anchor set, so a single null check covers
 * them and the two `scalarAt` calls always agree on segment boundaries.
 */
export function valueAt(
  bank: readonly MotionStep[],
  barPos: number,
  mode: MotionMode,
  neighbours: MotionNeighbours = {},
): MotionXY | null {
  const x = scalarAt(bank, barPos, mode, getX, neighbours);
  if (x === null) return null;
  return { x, y: scalarAt(bank, barPos, mode, getY, neighbours)! };
}

/** One extra single-param track (motion-sequencer.md REQ-13/REQ-14). */
export function valueAt1D(
  steps: readonly MotionTrackStep[],
  barPos: number,
  mode: MotionMode,
  neighbours: MotionTrackNeighbours = {},
): number | null {
  return scalarAt(steps, barPos, mode, getV, neighbours);
}
