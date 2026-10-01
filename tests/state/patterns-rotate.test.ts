// step-grid-editing.md REQ-shift-rotates-the-played-window — Clear ▾'s shift: a
// rotation of the played window, whole steps at a time, as one undo.
import { describe, it, expect } from 'vitest';
import { PatternStore } from '../../src/state/patterns';
import { PatternUndo } from '../../src/state/pattern-undo';

/** A store whose edit banks start empty — a new one ships with a default groove. */
function emptyStore(): PatternStore {
  const p = new PatternStore();
  p.clearSeqBank();
  p.clearDrumBank();
  p.clearSamplerBank();
  return p;
}

const onCells = (row: readonly { on: boolean }[]): number[] =>
  row.flatMap((c, i) => (c.on ? [i] : []));

describe('PatternStore.rotate*Bank', () => {
  it('rotates every drum row one cell later, wrapping, and one undo restores it', () => {
    const p = emptyStore();
    const undo = new PatternUndo(p);
    p.setDrumCell(0, 0, { on: true, velocity: 0.4 });
    p.setDrumCell(0, 15, { on: true });
    p.setDrumCell(2, 4, { on: true });

    expect(p.rotateDrumBank(1, 16)).toBe(true);
    expect(onCells(p.drum[0]!)).toEqual([0, 1]);   // 15 wrapped to 0, 0 moved to 1
    expect(onCells(p.drum[2]!)).toEqual([5]);
    expect(p.drum[0]![1]!.velocity).toBe(0.4);      // the step's settings moved with it

    undo.undo('drum');
    expect(onCells(p.drum[0]!)).toEqual([0, 15]);
    expect(onCells(p.drum[2]!)).toEqual([4]);
  });

  it('left and right are inverse', () => {
    const p = emptyStore();
    p.setSeqStep(1, 3, { on: true, note: 64, gate: 0.3, micro: 2 });
    const before = p.seq.map((row) => row.map((s) => ({ ...s })));
    p.rotateSeqBank(-1, 16);
    expect(p.seq[1]![2]).toMatchObject({ on: true, note: 64, gate: 0.3, micro: 2 });
    p.rotateSeqBank(1, 16);
    expect(p.seq.map((row) => row.map((s) => ({ ...s })))).toEqual(before);
  });

  it('wraps within the played window and leaves the dark cells alone', () => {
    const p = emptyStore();
    p.setSamplerCell(0, 11, { on: true });   // last cell of a 12-cell (3/4) window
    p.setSamplerCell(0, 14, { on: true });   // dark: past the window
    p.rotateSamplerBank(1, 12);
    expect(onCells(p.sampler[0]!)).toEqual([0, 14]);
  });

  it('keeps every step object, so a holder of one is not orphaned', () => {
    const p = emptyStore();
    p.setDrumCell(0, 0, { on: true });
    const held = p.drum[0]![0]!;
    p.rotateDrumBank(1, 16);
    expect(p.drum[0]![0]).toBe(held);
  });

  it('an empty bank shifts nothing and records no undo', () => {
    const p = emptyStore();
    let mutations = 0;
    p.onMutate(() => { mutations++; });
    expect(p.rotateSeqBank(1, 16)).toBe(false);
    expect(p.rotateDrumBank(-1, 12)).toBe(false);
    expect(mutations).toBe(0);
  });
});
