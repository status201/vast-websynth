import { describe, it, expect } from 'vitest';
import { StepButton } from '../../src/ui/components/step-button';
import { PlayheadHighlighter } from '../../src/ui/components/playhead-highlighter';

function grid(rows: number, cols: number): StepButton[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => new StepButton('')));
}

/** Column indices currently flagged as playing across all rows. */
function playingCols(g: StepButton[][]): number[] {
  const cols = new Set<number>();
  g.forEach((row) => row.forEach((c, i) => { if (c.playing) cols.add(i); }));
  return [...cols].sort((a, b) => a - b);
}

describe('PlayheadHighlighter', () => {
  it('highlights a whole column across every row', () => {
    const g = grid(3, 4);
    const hl = new PlayheadHighlighter(g);
    hl.update(2, true);
    expect(g.every((row) => row[2]!.playing)).toBe(true);
    expect(playingCols(g)).toEqual([2]);
  });

  it('moves the highlight, leaving only one column lit', () => {
    const g = grid(3, 4);
    const hl = new PlayheadHighlighter(g);
    hl.update(1, true);
    hl.update(3, true);
    expect(playingCols(g)).toEqual([3]);
  });

  it('clears the highlight when inactive', () => {
    const g = grid(2, 4);
    const hl = new PlayheadHighlighter(g);
    hl.update(1, true);
    hl.update(1, false);     // not viewing the playing bank
    expect(playingCols(g)).toEqual([]);
    hl.clear();              // idempotent
    expect(playingCols(g)).toEqual([]);
  });

  it('is a no-op when the column is unchanged', () => {
    const g = grid(1, 4);
    const hl = new PlayheadHighlighter(g);
    hl.update(2, true);
    const cell = g[0]![2]!;
    // Re-asserting the same column must not flip the cell state.
    hl.update(2, true);
    expect(cell.playing).toBe(true);
    expect(playingCols(g)).toEqual([2]);
  });

  it('supports a single flat row (sequencer layout)', () => {
    const steps = Array.from({ length: 16 }, () => new StepButton(''));
    const hl = new PlayheadHighlighter([steps]);
    hl.update(7, true);
    expect(steps[7]!.playing).toBe(true);
    expect(steps.filter((s) => s.playing)).toHaveLength(1);
  });
});
