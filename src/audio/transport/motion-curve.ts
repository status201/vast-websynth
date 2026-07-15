import type { MotionStep } from '../../state/patterns';

/**
 * Pure motion-sequencer curve math (no AudioContext, like step-hits.ts).
 *
 * A motion bank's ON steps are *anchors*. `valueAt` evaluates the bank at a
 * fractional bar position:
 *   - 'step'  — the most recent anchor at/before the position holds its value
 *               (before the first anchor the *last* anchor holds, i.e. the value
 *               carried over the bar loop).
 *   - 'slide' — piecewise-linear between consecutive anchors, across unset gaps,
 *               wrapping last→first anchor over the bar boundary.
 * A bank with no anchors evaluates to null (the machine writes nothing).
 * Coordinates stay in the 0..1 normalized taper space of the XY pad; mapping to
 * real param values happens in the machine via fromNorm.
 */

export type MotionMode = 'step' | 'slide';

export interface MotionXY {
  x: number;
  y: number;
}

/** Indices of the bank's ON steps, ascending. */
export function anchorIndices(bank: readonly MotionStep[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bank.length; i++) if (bank[i]!.on) out.push(i);
  return out;
}

/**
 * Evaluate the bank at `barPos` ∈ [0, 1) (fraction of the bar; an anchor at
 * step i sits at position i / bank.length). Out-of-range positions wrap.
 */
export function valueAt(
  bank: readonly MotionStep[],
  barPos: number,
  mode: MotionMode
): MotionXY | null {
  const idx = anchorIndices(bank);
  if (idx.length === 0) return null;
  const first = bank[idx[0]!]!;
  if (idx.length === 1) return { x: first.x, y: first.y };

  const n = bank.length;
  const p = (((barPos % 1) + 1) % 1) * n; // position in step units, [0, n)

  // Last anchor at or before p (-1 when p precedes the first anchor).
  let prev = -1;
  for (const i of idx) {
    if (i <= p) prev = i;
    else break;
  }

  if (mode === 'step') {
    const at = prev >= 0 ? prev : idx[idx.length - 1]!;
    const s = bank[at]!;
    return { x: s.x, y: s.y };
  }

  // Slide: find the surrounding segment a→b (wrapping over the bar boundary).
  let a: number, b: number, span: number, dist: number;
  if (prev < 0) {
    // Before the first anchor: inside the wrapped last→first segment.
    a = idx[idx.length - 1]!;
    b = idx[0]!;
    span = n - a + b;
    dist = p + n - a;
  } else if (prev === idx[idx.length - 1]) {
    // After the last anchor: wrap toward the first.
    a = prev;
    b = idx[0]!;
    span = n - a + b;
    dist = p - a;
  } else {
    a = prev;
    b = idx[idx.indexOf(prev) + 1]!;
    span = b - a;
    dist = p - a;
  }
  const t = span > 0 ? Math.min(1, Math.max(0, dist / span)) : 0;
  const sa = bank[a]!;
  const sb = bank[b]!;
  return { x: sa.x + (sb.x - sa.x) * t, y: sa.y + (sb.y - sa.y) * t };
}
