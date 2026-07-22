import { describe, it, expect, vi } from 'vitest';
import { PatternStore } from '../../src/state/patterns';
import { PatternUndo } from '../../src/state/pattern-undo';

function build(opts?: { depth?: number; coalesceMs?: number }) {
  const patterns = new PatternStore();
  const undo = new PatternUndo(patterns, opts);
  return { patterns, undo };
}

describe('PatternUndo', () => {
  it('undoes a drum cell toggle', () => {
    const { patterns, undo } = build();
    expect(patterns.drum[0]![3]!.on).toBe(false);
    patterns.setDrumCell(0, 3, { on: true });
    expect(undo.canUndo('drum')).toBe(true);
    undo.undo('drum');
    expect(patterns.drum[0]![3]!.on).toBe(false);
    expect(undo.canUndo('drum')).toBe(false);
  });

  it('undoes seq / sampler / motion edits on their own stacks', () => {
    const { patterns, undo } = build();
    patterns.setSeqStep(2, { on: true, note: 71 });
    patterns.setSamplerCell(1, 4, { on: true });
    patterns.setMotionStep(5, { on: true, x: 0.1, y: 0.9 });
    expect(undo.canUndo('seq')).toBe(true);
    expect(undo.canUndo('sampler')).toBe(true);
    expect(undo.canUndo('motion')).toBe(true);
    expect(undo.canUndo('drum')).toBe(false);
    undo.undo('seq');
    expect(patterns.seq[2]!.on).toBe(false);
    undo.undo('sampler');
    expect(patterns.sampler[1]![4]!.on).toBe(false);
    undo.undo('motion');
    expect(patterns.motion[5]!.on).toBe(false);
  });

  it('a same-cell drag coalesces into one undo step (oldest before wins)', () => {
    const { patterns, undo } = build();
    const before = patterns.drum[0]![0]!.velocity;
    // A StepSettingsEditor drag: many set() calls on one cell in quick succession.
    for (let v = 10; v <= 100; v += 10) patterns.setDrumCell(0, 0, { velocity: v / 100 });
    undo.undo('drum');
    expect(patterns.drum[0]![0]!.velocity).toBe(before);
    expect(undo.canUndo('drum')).toBe(false);
  });

  it('edits to different cells do not coalesce', () => {
    // Track 3 (open hat) is empty in the seeded default groove.
    const { patterns, undo } = build();
    patterns.setDrumCell(3, 0, { on: true });
    patterns.setDrumCell(3, 1, { on: true });
    undo.undo('drum');
    expect(patterns.drum[3]![1]!.on).toBe(false);
    expect(undo.canUndo('drum')).toBe(true);
    undo.undo('drum');
    expect(patterns.drum[3]![0]!.on).toBe(false);
  });

  it('undo navigates back to the bank the edit was made in', () => {
    const { patterns, undo } = build();
    patterns.setSeqEditBank(1);
    patterns.setSeqStep(0, { on: true, note: 60 });
    patterns.setSeqEditBank(2);
    undo.undo('seq');
    expect(patterns.seqEditBank).toBe(1);
    expect(patterns.seqBanks[1]![0]!.on).toBe(false);
  });

  it('undoes a bank copy (destination contents restore)', () => {
    const { patterns, undo } = build();
    // Bank B (1) holds something worth losing.
    patterns.setDrumEditBank(1);
    patterns.setDrumCell(2, 7, { on: true });
    patterns.setDrumEditBank(0);
    patterns.copyDrumBank(0, 1); // A → B wipes B's cell (A's default groove differs)
    expect(patterns.drumBanks[1]![2]![7]!.on).toBe(false);
    undo.undo('drum');
    expect(patterns.drumBanks[1]![2]![7]!.on).toBe(true);
    expect(patterns.drumEditBank).toBe(1); // undo shows where it reverted
  });

  it('undoes a motion bank copy including the axis override', () => {
    const { patterns, undo } = build();
    patterns.setMotionEditBank(1);
    patterns.setMotionAssign({ x: 'filter.cutoff' });
    patterns.setMotionEditBank(0);
    patterns.copyMotionBank(0, 1); // B's override becomes A's (null)
    expect(patterns.motionAssign(1)).toBeNull();
    undo.undo('motion'); // the copy, not the setMotionAssign
    expect(patterns.motionAssign(1)).toEqual({ x: 'filter.cutoff' });
  });

  it('restore() clears every stack (song load / import / New)', () => {
    const { patterns, undo } = build();
    patterns.setSeqStep(0, { on: true });
    patterns.setDrumCell(0, 0, { on: true });
    patterns.setSamplerCell(0, 0, { on: true });
    patterns.setMotionStep(0, { on: true });
    patterns.restore({});
    for (const m of ['seq', 'drum', 'sampler', 'motion'] as const) {
      expect(undo.canUndo(m)).toBe(false);
    }
  });

  it('undo application does not record itself', () => {
    const { patterns, undo } = build();
    patterns.setDrumCell(0, 3, { on: true });
    undo.undo('drum');
    // If the undo's own setDrumCell had been recorded, this would revert it.
    expect(undo.canUndo('drum')).toBe(false);
  });

  it('captured before-state is isolated from later in-place mutation', () => {
    const { patterns, undo } = build();
    patterns.setDrumCell(3, 3, { on: true });       // captures before {on:false, vel:0.85}
    patterns.setDrumCell(3, 3, { velocity: 0.3 });  // same key — coalesces onto that entry
    patterns.setDrumCell(3, 5, { on: true });       // mutates a DIFFERENT cell in place
    undo.undo('drum'); // the 3,5 edit
    undo.undo('drum'); // the whole 3,3 gesture — its before must be untouched
    expect(patterns.drum[3]![3]!.on).toBe(false);
    expect(patterns.drum[3]![3]!.velocity).toBe(0.85);
  });

  it('respects the depth cap', () => {
    const { patterns, undo } = build({ depth: 2, coalesceMs: 0 });
    patterns.setDrumCell(0, 0, { on: true });
    patterns.setDrumCell(0, 1, { on: true });
    patterns.setDrumCell(0, 2, { on: true });
    undo.undo('drum');
    undo.undo('drum');
    expect(undo.canUndo('drum')).toBe(false); // the first edit fell off
    expect(patterns.drum[0]![0]!.on).toBe(true);
  });

  it('onChange fires as stacks grow and shrink', () => {
    const { patterns, undo } = build();
    const fn = vi.fn();
    undo.onChange(fn);
    patterns.setDrumCell(0, 0, { on: true });
    undo.undo('drum');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('setSampleName is not captured (pattern-undo.md REQ-11)', () => {
    const { patterns, undo } = build();
    patterns.setSampleName(0, 'kick.wav');
    expect(undo.canUndo('sampler')).toBe(false);
  });
});

describe('PatternUndo — bulk clears (step-grid-editing.md REQ-7)', () => {
  it('one Undo press restores a whole cleared drum bank', () => {
    // Bank A boots with the seeded groove, so nothing has to be edited first —
    // the stack starts empty and its final size is the entry count of the clear.
    const { patterns, undo } = build();
    const before = patterns.drumBanks[0]!.map((r) => r.map((c) => ({ ...c })));
    expect(before.some((r) => r.some((c) => c.on))).toBe(true);
    patterns.clearDrumBank();
    expect(patterns.drum.every((r) => r.every((c) => !c.on))).toBe(true);

    undo.undo('drum');
    expect(patterns.drumBanks[0]).toEqual(before);
    expect(undo.canUndo('drum')).toBe(false); // exactly one entry was pushed
  });

  it('a row clear also costs one entry and restores the row', () => {
    const { patterns, undo } = build();
    const before = patterns.drumBanks[0]![0]!.map((c) => ({ ...c }));
    patterns.clearDrumTrack(0);
    expect(patterns.drum[0]!.some((c) => c.on)).toBe(false);
    undo.undo('drum');
    expect(patterns.drumBanks[0]![0]).toEqual(before);
    expect(undo.canUndo('drum')).toBe(false);
  });

  it('undo of a seq bank clear brings back notes and settings together', () => {
    const { patterns, undo } = build();
    patterns.setSeqStep(2, { on: true, note: 67, ratchet: 4 });
    patterns.setSeqStep(9, { on: true, note: 71 });
    patterns.clearSeqBank();
    undo.undo('seq');
    expect(patterns.seq[2]).toMatchObject({ on: true, note: 67, ratchet: 4 });
    expect(patterns.seq[9]).toMatchObject({ on: true, note: 71 });
  });

  it('clearing an empty bank pushes nothing, so Undo still targets the prior edit', () => {
    const { patterns, undo } = build();
    patterns.setSeqEditBank(1);
    patterns.setSeqStep(0, { on: true, note: 60 });
    patterns.clearSeqBank();     // one entry
    patterns.clearSeqBank();     // no-op: bank is already empty
    undo.undo('seq');
    expect(patterns.seq[0]!.on).toBe(true);
  });

  it('a motion bank clear restores anchors without disturbing the override', () => {
    const { patterns, undo } = build();
    patterns.setMotionAssign({ y: 'filter.cutoff' });
    patterns.setMotionStep(4, { on: true, x: 0.2, y: 0.8 });
    patterns.clearMotionBank();
    undo.undo('motion');
    expect(patterns.motion[4]).toMatchObject({ on: true, x: 0.2, y: 0.8 });
    expect(patterns.motionAssign(0)).toEqual({ y: 'filter.cutoff' });
  });
});
