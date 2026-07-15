/** Anything with a playing-highlight — StepButton, MotionStepPad, … */
export interface PlayheadCell {
  setPlaying(p: boolean): void;
}

/**
 * Moves the playing-step highlight across a step grid as the transport
 * advances, touching only the leaving and entering columns instead of
 * rescanning every cell each tick. Shared by the sequencer, drum, sampler
 * and motion panels (`rows` is row-major: `rows[track][step]`; the sequencer
 * and motion panels pass a single row).
 */
export class PlayheadHighlighter {
  private prev = -1;

  constructor(private readonly rows: readonly (readonly PlayheadCell[])[]) {}

  /** Highlight column `col` when `active`; clears the highlight otherwise. */
  update(col: number, active: boolean): void {
    const next = active ? col : -1;
    if (next === this.prev) return;
    if (this.prev >= 0) for (const r of this.rows) r[this.prev]?.setPlaying(false);
    if (next >= 0) for (const r of this.rows) r[next]?.setPlaying(true);
    this.prev = next;
  }

  /** Remove the current highlight (e.g. on a bank switch or song restore). */
  clear(): void {
    this.update(-1, false);
  }
}
