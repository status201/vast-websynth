import type { MotionStep } from '../../state/patterns';

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
 */

export type MotionMode = 'step' | 'slide';

export interface MotionXY {
  x: number;
  y: number;
}

/**
 * The banks playing in the adjacent bars. Absent ⇒ `bank` itself (a looping
 * bank). `null` or anchorless ⇒ nothing to carry to/from, so the curve holds flat
 * at the bar line instead of ramping toward a meaningless target. Callers own the
 * *usability* rule (a resting bar, or one driving different params, passes null) —
 * this module stays pure curve math.
 */
export interface MotionNeighbours {
  prev?: readonly MotionStep[] | null;
  next?: readonly MotionStep[] | null;
}

/** Indices of the bank's ON steps, ascending. */
export function anchorIndices(bank: readonly MotionStep[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bank.length; i++) if (bank[i]!.on) out.push(i);
  return out;
}

/** An adjacent bar's anchors, or null when there is nothing to carry to/from. */
interface Carry {
  bank: readonly MotionStep[];
  idx: number[];
}

/** Absent neighbour ⇒ `bank` itself (the looping-bank self-wrap); null or
 *  anchorless ⇒ no carry, so the caller holds its outer anchor flat. */
function carryFrom(
  neighbour: readonly MotionStep[] | null | undefined,
  bank: readonly MotionStep[],
): Carry | null {
  const b = neighbour === undefined ? bank : neighbour;
  if (!b) return null;
  const idx = anchorIndices(b);
  return idx.length ? { bank: b, idx } : null;
}

const xy = (s: MotionStep): MotionXY => ({ x: s.x, y: s.y });

/**
 * Evaluate the bank at `barPos` ∈ [0, 1) (fraction of the bar; an anchor at
 * step i sits at position i / bank.length). Out-of-range positions wrap.
 * `neighbours` are the adjacent bars' banks — see MotionNeighbours.
 */
export function valueAt(
  bank: readonly MotionStep[],
  barPos: number,
  mode: MotionMode,
  neighbours: MotionNeighbours = {},
): MotionXY | null {
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
    if (prev >= 0) return xy(bank[prev]!);
    // Before the first anchor: whatever the previous bar left holds.
    const carry = carryFrom(neighbours.prev, bank);
    return xy(carry ? carry.bank[carry.idx[carry.idx.length - 1]!]! : bank[firstIdx]!);
  }

  // Slide: find the surrounding segment a→b (the outer two span the bar line).
  let sa: MotionStep, sb: MotionStep;
  let span: number, dist: number;
  if (prev < 0) {
    // Before the first anchor: still inside the segment carried in from the
    // previous bar, which ends on this bank's first anchor.
    const carry = carryFrom(neighbours.prev, bank);
    if (!carry) return xy(bank[firstIdx]!);
    const a = carry.idx[carry.idx.length - 1]!;
    sa = carry.bank[a]!;
    sb = bank[firstIdx]!;
    span = n - a + firstIdx;
    dist = p + n - a;
  } else if (prev === lastIdx) {
    // After the last anchor: head for the next bar's first anchor.
    const carry = carryFrom(neighbours.next, bank);
    if (!carry) return xy(bank[lastIdx]!);
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
  return { x: sa.x + (sb.x - sa.x) * t, y: sa.y + (sb.y - sa.y) * t };
}
