import { describe, it, expect } from 'vitest';
import { PatternStore, SEQ_TRACK_COUNT } from '../../src/state/patterns';
import { PatternUndo } from '../../src/state/pattern-undo';
import { buildQuantizeTable, diatonicChord, SCALE_LABELS } from '../../src/utils/music';

// chord-tools.md REQ-2/REQ-3/REQ-4, scale-quantization.md REQ-8.
// These pin the STORE's two batch mutations, which take plain data and know no
// music theory — the theory is applied by the caller and tested in utils/music.

function build() {
  const patterns = new PatternStore();
  const undo = new PatternUndo(patterns);
  // Start from a clean bank so each assertion is about what the test wrote.
  patterns.clearSeqBank();
  return { patterns, undo };
}

/** Every track's step at `index`, as [on, note] pairs. */
function column(patterns: PatternStore, index: number): [boolean, number][] {
  return Array.from({ length: SEQ_TRACK_COUNT }, (_, t) => {
    const s = patterns.seqTrack(t)![index]!;
    return [s.on, s.note] as [boolean, number];
  });
}

describe('writeSeqChord', () => {
  it('writes the notes down the tracks at one step', () => {
    const { patterns } = build();
    expect(patterns.writeSeqChord(0, [60, 64, 67])).toBe(true);
    expect(column(patterns, 0)).toEqual([[true, 60], [true, 64], [true, 67], [false, 60]]);
  });

  it('switches off the tracks the chord does not reach (REQ-2)', () => {
    // A triad over a 7th must not leave the old seventh ringing underneath.
    const { patterns } = build();
    patterns.writeSeqChord(0, [60, 64, 67, 71]);
    patterns.writeSeqChord(0, [60, 64, 67]);
    expect(column(patterns, 0)[3]).toEqual([false, 71]);
  });

  it('keeps each step\'s existing shape, patching only on and note (REQ-2)', () => {
    const { patterns } = build();
    patterns.setSeqStep(1, 0, { velocity: 0.3, gate: 0.9, ratchet: 3, tie: true, prob: 0.5 });
    patterns.writeSeqChord(0, [60, 64, 67]);
    const s = patterns.seqTrack(1)![0]!;
    expect(s.note).toBe(64);
    expect(s.on).toBe(true);
    expect({ velocity: s.velocity, gate: s.gate, ratchet: s.ratchet, tie: s.tie, prob: s.prob })
      .toEqual({ velocity: 0.3, gate: 0.9, ratchet: 3, tie: true, prob: 0.5 });
  });

  it('touches only the step index it was given', () => {
    const { patterns } = build();
    patterns.setSeqStep(0, 5, { on: true, note: 72 });
    patterns.writeSeqChord(0, [60, 64, 67]);
    expect(patterns.seqTrack(0)![5]).toMatchObject({ on: true, note: 72 });
  });

  it('costs exactly one undo entry for the whole chord (REQ-3)', () => {
    const { patterns, undo } = build();
    const before = patterns.seqBanks[0]!.map((r) => r.map((s) => ({ ...s })));
    patterns.writeSeqChord(0, [60, 64, 67, 71]);
    undo.undo('seq');
    expect(patterns.seqBanks[0]).toEqual(before);
    expect(undo.canUndo('seq')).toBe(false); // one entry, not four
  });

  it('rejects an empty chord and an out-of-range step', () => {
    const { patterns } = build();
    expect(patterns.writeSeqChord(0, [])).toBe(false);
    expect(patterns.writeSeqChord(-1, [60])).toBe(false);
    expect(patterns.writeSeqChord(99, [60])).toBe(false);
  });

  it('writes what diatonicChord produced, end to end', () => {
    // The seam between the theory and the store: ii in C major = D F A.
    const { patterns } = build();
    const notes = diatonicChord(60, 0, SCALE_LABELS.indexOf('major'), [0, 2, 4], 1);
    patterns.writeSeqChord(3, notes);
    expect(column(patterns, 3).slice(0, 3)).toEqual([[true, 62], [true, 65], [true, 69]]);
  });
});

describe('snapSeqBank', () => {
  const MAJOR = SCALE_LABELS.indexOf('major');

  it('rewrites every out-of-key note in the bank', () => {
    const { patterns } = build();
    patterns.setSeqStep(0, 0, { on: true, note: 61 });
    patterns.setSeqStep(1, 4, { on: true, note: 66 });
    const table = buildQuantizeTable(0, MAJOR)!;
    expect(patterns.snapSeqBank((n) => table[n] ?? n)).toBe(true);
    expect(patterns.seqTrack(0)![0]!.note).toBe(60);
    expect(patterns.seqTrack(1)![4]!.note).toBe(65);
  });

  it('reports false and pushes no undo when nothing moves', () => {
    const { patterns, undo } = build();
    patterns.setSeqStep(0, 0, { on: true, note: 60 });
    const table = buildQuantizeTable(0, MAJOR)!;
    // Every seeded note is already in C major after the first pass.
    patterns.snapSeqBank((n) => table[n] ?? n);
    const stack = undo.canUndo('seq');
    expect(patterns.snapSeqBank((n) => table[n] ?? n)).toBe(false);
    expect(undo.canUndo('seq')).toBe(stack); // no new entry
  });

  it('restores all four tracks from one undo (REQ-3)', () => {
    const { patterns, undo } = build();
    patterns.setSeqStep(0, 0, { on: true, note: 61 });
    patterns.setSeqStep(1, 1, { on: true, note: 63 });
    patterns.setSeqStep(2, 2, { on: true, note: 66 });
    patterns.setSeqStep(3, 3, { on: true, note: 68 });
    const before = patterns.seqBanks[0]!.map((r) => r.map((s) => ({ ...s })));

    const table = buildQuantizeTable(0, MAJOR)!;
    patterns.snapSeqBank((n) => table[n] ?? n);
    expect(patterns.seqBanks[0]).not.toEqual(before);

    undo.undo('seq');
    expect(patterns.seqBanks[0]).toEqual(before);
  });

  it('snaps steps that are off too, so turning one on is already in key', () => {
    const { patterns } = build();
    patterns.setSeqStep(0, 7, { on: false, note: 61 });
    const table = buildQuantizeTable(0, MAJOR)!;
    patterns.snapSeqBank((n) => table[n] ?? n);
    expect(patterns.seqTrack(0)![7]!.note).toBe(60);
  });

  it('is idempotent — snapping twice changes nothing the second time', () => {
    const { patterns } = build();
    patterns.setSeqStep(0, 0, { on: true, note: 61 });
    const table = buildQuantizeTable(0, MAJOR)!;
    patterns.snapSeqBank((n) => table[n] ?? n);
    const after = patterns.seqBanks[0]!.map((r) => r.map((s) => ({ ...s })));
    expect(patterns.snapSeqBank((n) => table[n] ?? n)).toBe(false);
    expect(patterns.seqBanks[0]).toEqual(after);
  });
});
