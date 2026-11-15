import { describe, it, expect } from 'vitest';
import { EditHistory } from '../../src/state/edit-history';

/** sample-recorder.md REQ-undo-is-a-stack — snapshots here are numbers whose size is themselves. */
const mk = (depth = 10, budget = Infinity) =>
  new EditHistory<number>({ depth, budget, size: (n) => n });

describe('EditHistory (REQ-undo-is-a-stack)', () => {
  it('walks edits back and forward', () => {
    const h = mk();
    let cur = 0;
    for (const next of [1, 2, 3]) { h.record(cur); cur = next; }
    expect(h.canRedo).toBe(false);
    cur = h.undo(cur)!; expect(cur).toBe(2);
    cur = h.undo(cur)!; expect(cur).toBe(1);
    cur = h.undo(cur)!; expect(cur).toBe(0);
    expect(h.canUndo).toBe(false);
    expect(h.undo(cur)).toBeNull();
    cur = h.redo(cur)!; expect(cur).toBe(1);
  });

  it('a new edit forgets Redo', () => {
    const h = mk();
    h.record(0);
    h.undo(1);
    expect(h.canRedo).toBe(true);
    h.record(0);
    expect(h.canRedo).toBe(false);
  });

  it('keeps at most `depth` undo steps', () => {
    const h = mk(3);
    let cur = 0;
    for (let i = 1; i <= 6; i++) { h.record(cur); cur = i; }
    let n = 0;
    while (h.canUndo) { cur = h.undo(cur)!; n++; }
    expect(n).toBe(3);
    expect(cur).toBe(3); // the three oldest were dropped
  });

  it('drops the oldest past the budget, but always keeps the newest', () => {
    const h = mk(10, 10);
    h.record(6);
    h.record(6); // 12 > 10: the first goes
    let n = 0;
    let cur = 0;
    while (h.canUndo) { cur = h.undo(cur)!; n++; }
    expect(n).toBe(1);

    const big = mk(10, 1);
    big.record(50); // over budget on its own, and still undoable
    expect(big.canUndo).toBe(true);
  });
});
