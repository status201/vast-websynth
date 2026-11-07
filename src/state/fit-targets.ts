/**
 * The musical lengths the sample editor's Fit and Scratch rows offer — pure, so
 * the labels and the preselection are testable without the editor
 * (time-stretch.md REQ-the-fit-row-preselects-the-nearest-target).
 */
import { MAX_SCRATCH_STEPS } from './limits';
import { plural } from '../utils/format';

/** Lengths in sixteenths: every step count to two bars, then 48 and the scratch ceiling. */
export const FIT_TARGETS: readonly number[] = [
  ...Array.from({ length: 32 }, (_, i) => i + 1), 48, MAX_SCRATCH_STEPS,
];

/** `16 · 1 bar`, `8 · ½ bar`, `5` — the step count, and the bars when they are round. */
export function fitLabel(steps: number, barTicks: number): string {
  const bars = steps / Math.max(1, barTicks);
  if (Number.isInteger(bars)) return `${steps} · ${plural(bars, 'bar')}`;
  if (bars === 0.5) return `${steps} · ½ bar`;
  if (bars === 0.25) return `${steps} · ¼ bar`;
  return `${steps}`;
}

/**
 * The target whose length (`framesFor`) is closest to `frames` — what both rows
 * preselect, so the first thing offered is the one that barely moves the audio.
 * A tie keeps the shorter target.
 */
export function nearestTarget(frames: number, framesFor: (steps: number) => number): number {
  let best = FIT_TARGETS[0]!;
  let bestErr = Infinity;
  for (const s of FIT_TARGETS) {
    const err = Math.abs(framesFor(s) - frames);
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return best;
}
