import { describe, it, expect } from 'vitest';
import { PatternStore, SEQ_LENGTH, BANK_COUNT, SAMPLER_SLOT_COUNT, type SeqStep } from '../../src/state/patterns';

describe('PatternStore', () => {
  it('seeds a default groove into drum bank A only', () => {
    const ps = new PatternStore();
    const a = ps.drumBank(0);
    expect(a[0]!.filter((c) => c.on).length).toBe(4); // kick on 0,4,8,12
    expect(a[0]![0]!.on).toBe(true);
    expect(a[0]![4]!.on).toBe(true);
    expect(a[1]![4]!.on).toBe(true); // snare backbeat
    expect(a[1]![12]!.on).toBe(true);
    expect(a[2]![2]!.on).toBe(true); // offbeat hats
    // banks B/C/D stay empty
    const b = ps.drumBank(1);
    expect(b.every((row) => row.every((c) => !c.on))).toBe(true);
  });

  it('setSeqStep mutates the edit bank and notifies', () => {
    const ps = new PatternStore();
    const calls: Array<[number, boolean]> = [];
    ps.onSeqChange((i, s) => calls.push([i, s.on]));
    ps.setSeqStep(3, { on: true, note: 64 });
    expect(ps.seq[3]!.on).toBe(true);
    expect(ps.seq[3]!.note).toBe(64);
    expect(ps.seqBanks[0]![3]!.note).toBe(64);
    expect(calls).toEqual([[3, true]]);
  });

  it('setDrumCell mutates the edit bank and notifies', () => {
    const ps = new PatternStore();
    let got: [number, number, boolean] | null = null;
    ps.onDrumChange((t, s, c) => {
      got = [t, s, c.on];
    });
    ps.setDrumCell(5, 7, { on: true });
    expect(ps.drum[5]![7]!.on).toBe(true);
    expect(got).toEqual([5, 7, true]);
  });

  it('clamps out-of-range bank indices', () => {
    const ps = new PatternStore();
    expect(ps.seqBank(99)).toBe(ps.seqBanks[BANK_COUNT - 1]);
    expect(ps.seqBank(-5)).toBe(ps.seqBanks[0]);
    ps.setSeqEditBank(99);
    expect(ps.seqEditBank).toBe(BANK_COUNT - 1);
  });

  it('setSeqEditBank fires batch bank listener once (not per-step)', () => {
    const ps = new PatternStore();
    let bankCalls = 0;
    let perStepCalls = 0;
    ps.onSeqBankChange(() => bankCalls++);
    ps.onSeqChange(() => perStepCalls++);
    ps.setSeqEditBank(1);
    expect(bankCalls).toBe(1);
    expect(perStepCalls).toBe(0);
    ps.setSeqEditBank(1); // no-op when unchanged
    expect(bankCalls).toBe(1);
  });

  it('onSeqBankChange receives the full bank array from the switched bank', () => {
    const ps = new PatternStore();
    let received: SeqStep[] | null = null;
    ps.onSeqBankChange((bank) => { received = [...bank]; });
    ps.setSeqEditBank(1);
    ps.setSeqStep(3, { on: true, note: 72 });
    ps.setSeqEditBank(0);
    // received should now be bank 0 (fresh, step 3 untouched)
    expect(received?.length).toBe(SEQ_LENGTH);
    expect(received![3]!.on).toBe(false);
    // Switch back to bank 1, should see the mutation
    ps.setSeqEditBank(1);
    expect(received![3]!.on).toBe(true);
    expect(received![3]!.note).toBe(72);
  });

  it('copySeqBank deep-copies and skips same-bank copies', () => {
    const ps = new PatternStore();
    ps.setSeqStep(0, { on: true, note: 72 });
    ps.copySeqBank(0, 1);
    expect(ps.seqBanks[1]![0]!.note).toBe(72);
    // independent objects, not shared references
    ps.seqBanks[1]![0]!.note = 48;
    expect(ps.seqBanks[0]![0]!.note).toBe(72);
    // same-bank copy is a safe no-op
    expect(() => ps.copySeqBank(2, 2)).not.toThrow();
  });

  it('copyDrumBank deep-copies cells', () => {
    const ps = new PatternStore();
    ps.copyDrumBank(0, 2); // bank A carries the seeded groove
    expect(ps.drumBanks[2]![0]![0]!.on).toBe(true);
    ps.drumBanks[2]![0]![0]!.on = false;
    expect(ps.drumBanks[0]![0]![0]!.on).toBe(true);
  });

  it('sampler banks default empty across all banks', () => {
    const ps = new PatternStore();
    for (let b = 0; b < BANK_COUNT; b++) {
      expect(ps.samplerBank(b).length).toBe(SAMPLER_SLOT_COUNT);
      expect(ps.samplerBank(b).every((sl) => sl.every((c) => !c.on))).toBe(true);
    }
    expect(ps.sampleNames.every((n) => n === null)).toBe(true);
  });

  it('setSamplerCell mutates the edit bank and notifies', () => {
    const ps = new PatternStore();
    let got: [number, number, boolean] | null = null;
    ps.onSamplerChange((sl, s, c) => { got = [sl, s, c.on]; });
    ps.setSamplerCell(2, 6, { on: true, velocity: 0.4 });
    expect(ps.sampler[2]![6]!.on).toBe(true);
    expect(ps.sampler[2]![6]!.velocity).toBe(0.4);
    expect(got).toEqual([2, 6, true]);
  });

  it('setSamplerEditBank fires batch bank listener once (not per-cell)', () => {
    const ps = new PatternStore();
    let bankCalls = 0;
    let perCellCalls = 0;
    ps.onSamplerBankChange(() => bankCalls++);
    ps.onSamplerChange(() => perCellCalls++);
    ps.setSamplerEditBank(1);
    expect(bankCalls).toBe(1);
    expect(perCellCalls).toBe(0);
    ps.setSamplerEditBank(1); // unchanged → no-op
    expect(bankCalls).toBe(1);
  });

  it('onDrumBankChange fires once on edit-bank switch', () => {
    const ps = new PatternStore();
    let bankCalls = 0;
    ps.onDrumBankChange(() => bankCalls++);
    ps.setDrumEditBank(2);
    expect(bankCalls).toBe(1);
    ps.setDrumEditBank(2); // no-op
    expect(bankCalls).toBe(1);
  });

  it('setSampleName stores per slot and notifies', () => {
    const ps = new PatternStore();
    const calls: Array<[number, string | null]> = [];
    ps.onSampleMetaChange((slot, name) => calls.push([slot, name]));
    ps.setSampleName(3, 'clap.wav');
    expect(ps.sampleNames[3]).toBe('clap.wav');
    ps.setSampleName(3, null);
    expect(ps.sampleNames[3]).toBeNull();
    expect(calls).toEqual([[3, 'clap.wav'], [3, null]]);
  });

  it('copySamplerBank deep-copies cells', () => {
    const ps = new PatternStore();
    ps.setSamplerCell(0, 0, { on: true });
    ps.copySamplerBank(0, 2);
    expect(ps.samplerBanks[2]![0]![0]!.on).toBe(true);
    ps.samplerBanks[2]![0]![0]!.on = false;
    expect(ps.samplerBanks[0]![0]![0]!.on).toBe(true);
  });

  it('sampler state round-trips through snapshot/restore', () => {
    const ps = new PatternStore();
    ps.setSamplerCell(4, 9, { on: true, velocity: 0.7 });
    ps.setSampleName(4, 'hat.mp3');
    const snap = ps.snapshot();

    const ps2 = new PatternStore();
    ps2.restore(snap);
    expect(ps2.samplerBanks[0]![4]![9]!.on).toBe(true);
    expect(ps2.samplerBanks[0]![4]![9]!.velocity).toBe(0.7);
    expect(ps2.sampleNames[4]).toBe('hat.mp3');
  });

  it('new seq steps default to prob 1, ratchet 1, tie false', () => {
    const ps = new PatternStore();
    const s = ps.seq[0]!;
    expect(s.prob).toBe(1);
    expect(s.ratchet).toBe(1);
    expect(s.tie).toBe(false);
  });

  it('prob/ratchet/tie round-trip through snapshot/restore', () => {
    const ps = new PatternStore();
    ps.setSeqStep(5, { on: true, prob: 0.5, ratchet: 3, tie: true });
    const snap = ps.snapshot();

    const ps2 = new PatternStore();
    ps2.restore(snap);
    expect(ps2.seqBanks[0]![5]!.prob).toBe(0.5);
    expect(ps2.seqBanks[0]![5]!.ratchet).toBe(3);
    expect(ps2.seqBanks[0]![5]!.tie).toBe(true);
  });

  it('restores legacy steps (missing the new fields) to the defaults', () => {
    const ps = new PatternStore();
    // Simulate a v1/v2 song whose seq steps predate prob/ratchet/tie.
    ps.restore({ seqBanks: [[{ on: true, note: 60, velocity: 0.8, gate: 0.5 }]] as SeqStep[][] });
    const s = ps.seqBanks[0]![0]!;
    expect(s.on).toBe(true);
    expect(s.prob).toBe(1);
    expect(s.ratchet).toBe(1);
    expect(s.tie).toBe(false);
  });

  it('round-trips through snapshot/restore', () => {
    const ps = new PatternStore();
    ps.setSeqStep(2, { on: true, note: 67, velocity: 0.5, gate: 0.9 });
    ps.setDrumCell(1, 3, { on: true, velocity: 0.6 });
    ps.setSeqEditBank(2);
    const snap = ps.snapshot();

    const ps2 = new PatternStore();
    ps2.restore(snap);
    expect(ps2.seqBanks[0]![2]!.note).toBe(67);
    expect(ps2.seqBanks[0]![2]!.gate).toBe(0.9);
    expect(ps2.drumBanks[0]![1]![3]!.on).toBe(true);
    expect(ps2.seqEditBank).toBe(2);

    // snapshot is a deep copy: mutating the store does not change the snap
    ps2.setSeqStep(2, { note: 1 });
    expect(snap.seqBanks[0]![2]!.note).toBe(67);
  });
});
