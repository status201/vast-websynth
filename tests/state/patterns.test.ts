import { describe, it, expect } from 'vitest';
import { PatternStore, SEQ_LENGTH, BANK_COUNT, SAMPLER_SLOT_COUNT, REST, clampChainStep, emptyPatternBanks, type SeqStep, type DrumCell } from '../../src/state/patterns';

describe('clampChainStep', () => {
  it('passes the REST sentinel through untouched', () => {
    expect(clampChainStep(REST)).toBe(REST);
  });
  it('clamps out-of-range indices to a real bank', () => {
    expect(clampChainStep(9)).toBe(BANK_COUNT - 1);
    expect(clampChainStep(-5)).toBe(0); // not REST → clamped to 0
    expect(clampChainStep(2)).toBe(2);
  });
});

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
    // Simulate a v1/v2 song whose seq steps predate prob/ratchet/tie —
    // after a live edit, so stale values must not survive the load.
    ps.setSeqStep(0, { prob: 0.3, ratchet: 4, tie: true });
    ps.restore({ seqBanks: [[{ on: true, note: 60, velocity: 0.8, gate: 0.5 }]] as SeqStep[][] });
    const s = ps.seqBanks[0]![0]!;
    expect(s.on).toBe(true);
    expect(s.prob).toBe(1);
    expect(s.ratchet).toBe(1);
    expect(s.tie).toBe(false);
  });

  it('new drum/sampler cells default to gate 1, prob 1, ratchet 1, tie false', () => {
    const ps = new PatternStore();
    for (const c of [ps.drum[0]![0]!, ps.sampler[0]![0]!]) {
      expect(c.gate).toBe(1);
      expect(c.prob).toBe(1);
      expect(c.ratchet).toBe(1);
      expect(c.tie).toBe(false);
    }
  });

  it('drum per-step settings round-trip through snapshot/restore and copyDrumBank', () => {
    const ps = new PatternStore();
    ps.setDrumCell(2, 5, { on: true, gate: 0.25, prob: 0.6, ratchet: 4, tie: true });
    ps.copyDrumBank(0, 1);
    expect(ps.drumBanks[1]![2]![5]!).toEqual({ on: true, velocity: 0.85, gate: 0.25, prob: 0.6, ratchet: 4, tie: true });

    const ps2 = new PatternStore();
    ps2.restore(ps.snapshot());
    expect(ps2.drumBanks[0]![2]![5]!.gate).toBe(0.25);
    expect(ps2.drumBanks[0]![2]![5]!.ratchet).toBe(4);
    expect(ps2.drumBanks[0]![2]![5]!.tie).toBe(true);
  });

  it('restores legacy drum/sampler cells (on/velocity only) to the defaults', () => {
    const ps = new PatternStore();
    // Live edits that a legacy load must reset.
    ps.setDrumCell(0, 0, { gate: 0.3, prob: 0.5, ratchet: 4, tie: true });
    ps.setSamplerCell(0, 0, { gate: 0.3 });
    ps.restore({
      drumBanks: [[[{ on: true, velocity: 0.7 }]]] as DrumCell[][][],
      samplerBanks: [[[{ on: true, velocity: 0.6 }]]] as DrumCell[][][],
    });
    const d = ps.drumBanks[0]![0]![0]!;
    expect(d).toEqual({ on: true, velocity: 0.7, gate: 1, prob: 1, ratchet: 1, tie: false });
    const s = ps.samplerBanks[0]![0]![0]!;
    expect(s).toEqual({ on: true, velocity: 0.6, gate: 1, prob: 1, ratchet: 1, tie: false });
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

describe('PatternStore — motion banks (motion-sequencer.md REQ-1/REQ-4)', () => {
  it('motion banks default empty (center coordinates, all off)', () => {
    const p = new PatternStore();
    for (let b = 0; b < BANK_COUNT; b++) {
      expect(p.motionBanks[b]!.length).toBe(SEQ_LENGTH);
      expect(p.motionBanks[b]!.every((s) => !s.on && s.x === 0.5 && s.y === 0.5)).toBe(true);
      expect(p.motionAssign(b)).toBeNull();
    }
  });

  it('setMotionStep mutates the edit bank and notifies', () => {
    const p = new PatternStore();
    let seen: unknown = null;
    p.onMotionChange((i, s) => { seen = [i, s.on, s.x, s.y]; });
    p.setMotionStep(3, { on: true, x: 0.2, y: 0.9 });
    expect(seen).toEqual([3, true, 0.2, 0.9]);
    expect(p.motion[3]).toMatchObject({ on: true, x: 0.2, y: 0.9 });
  });

  it('setMotionEditBank fires the whole-bank listener once', () => {
    const p = new PatternStore();
    let calls = 0;
    p.onMotionBankChange(() => { calls++; });
    p.setMotionEditBank(2);
    expect(calls).toBe(1);
  });

  it('setMotionAssign stores per edit bank, normalizes empty to null, repaints', () => {
    const p = new PatternStore();
    let repaints = 0;
    p.onMotionBankChange(() => { repaints++; });
    p.setMotionAssign({ x: 'fx.delay.mix' });
    expect(p.motionAssign(0)).toEqual({ x: 'fx.delay.mix' });
    expect(repaints).toBe(1);
    p.setMotionEditBank(1);
    expect(p.motionAssign(1)).toBeNull(); // per-bank
    p.setMotionEditBank(0);
    p.setMotionAssign({});
    expect(p.motionAssign(0)).toBeNull(); // empty override collapses to null
  });

  it('copyMotionBank deep-copies steps AND the assign override', () => {
    const p = new PatternStore();
    p.setMotionStep(0, { on: true, x: 0.1, y: 0.9 });
    p.setMotionAssign({ x: 'lfo.rate', y: 'lfo.amount' });
    p.copyMotionBank(0, 2);
    expect(p.motionBanks[2]![0]).toMatchObject({ on: true, x: 0.1, y: 0.9 });
    expect(p.motionAssign(2)).toEqual({ x: 'lfo.rate', y: 'lfo.amount' });
    p.setMotionStep(0, { x: 0.5 });
    expect(p.motionBanks[2]![0]!.x).toBe(0.1); // deep copy
  });

  it('motion state round-trips through snapshot/restore', () => {
    const p = new PatternStore();
    p.setMotionStep(5, { on: true, x: 0.3, y: 0.7 });
    p.setMotionAssign({ y: 'master.volume' });
    p.setMotionEditBank(0);
    const snap = p.snapshot();
    const q = new PatternStore();
    q.restore(snap);
    expect(q.motionBanks[0]![5]).toMatchObject({ on: true, x: 0.3, y: 0.7 });
    expect(q.motionAssign(0)).toEqual({ y: 'master.volume' });
  });

  it('restores sparse motion steps ({on:false}) with the defaults spread under', () => {
    const p = new PatternStore();
    p.setMotionStep(0, { on: true, x: 0, y: 0 });
    p.restore({ motionBanks: [[{ on: false } as never]] });
    expect(p.motionBanks[0]![0]).toMatchObject({ on: false, x: 0.5, y: 0.5 });
  });
});

describe('PatternStore onMutate / onBulkRestore (pattern-undo.md REQ-2/REQ-7)', () => {
  it('emits the pre-state clone for a cell mutation', () => {
    const p = new PatternStore();
    const seen: unknown[] = [];
    p.onMutate((m) => seen.push(m));
    p.setDrumCell(0, 3, { on: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'drum', bank: 0, track: 0, step: 3, before: { on: false } });
  });

  it('the emitted before is a clone, isolated from the in-place write', () => {
    const p = new PatternStore();
    let before: DrumCell | undefined;
    p.onMutate((m) => { if (m.kind === 'drum') before = m.before; });
    p.setDrumCell(0, 3, { on: true, velocity: 0.5 });
    expect(before!.on).toBe(false);
    expect(before!.velocity).not.toBe(0.5);
    expect(before).not.toBe(p.drum[0]![3]);
  });

  it('a bank copy emits the destination bank pre-state', () => {
    const p = new PatternStore();
    p.setSeqStep(0, { on: true, note: 64 }); // bank 0 = copy source
    p.setSeqEditBank(1);
    p.setSeqStep(1, { on: true, note: 65 }); // bank 1 = destination content
    const seen: unknown[] = [];
    p.onMutate((m) => seen.push(m));
    p.copySeqBank(0, 1);
    const copy = seen.find((m) => (m as { kind: string }).kind === 'seq-copy') as { bank: number; before: SeqStep[] };
    expect(copy.bank).toBe(1);
    expect(copy.before[1]!.on).toBe(true);
    expect(copy.before[0]!.on).toBe(false);
  });

  it('restore() fires onBulkRestore and never onMutate', () => {
    const p = new PatternStore();
    let bulk = 0;
    const mutations: unknown[] = [];
    p.onBulkRestore(() => bulk++);
    p.onMutate((m) => mutations.push(m));
    p.restore({ seqBanks: [[{ on: true, note: 60, velocity: 1, gate: 0.5 } as never]] });
    expect(bulk).toBe(1);
    expect(mutations).toHaveLength(0);
  });

  it('setSampleName never emits onMutate (REQ-11)', () => {
    const p = new PatternStore();
    const seen: unknown[] = [];
    p.onMutate((m) => seen.push(m));
    p.setSampleName(0, 'kick.wav');
    expect(seen).toHaveLength(0);
  });
});

describe('PatternStore bulk clears (step-grid-editing.md REQ-6/REQ-7)', () => {
  it('clearSeqBank clears only `on`, keeping every per-step setting (REQ-2)', () => {
    const p = new PatternStore();
    p.setSeqStep(3, { on: true, note: 64, velocity: 0.42, gate: 0.9, ratchet: 3, tie: true });
    expect(p.clearSeqBank()).toBe(true);
    const s = p.seq[3]!;
    expect(s.on).toBe(false);
    expect(s).toMatchObject({ note: 64, velocity: 0.42, gate: 0.9, ratchet: 3, tie: true });
  });

  it('emits exactly ONE bulk mutation, not one per cell', () => {
    const p = new PatternStore();
    for (let i = 0; i < SEQ_LENGTH; i++) p.setSeqStep(i, { on: true });
    const seen: unknown[] = [];
    p.onMutate((m) => seen.push(m));
    p.clearSeqBank();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'seq-copy', bank: 0 });
  });

  it('reports false and emits nothing on an already-empty bank', () => {
    const p = new PatternStore();
    p.setSeqEditBank(2); // untouched by the constructor's seeded groove
    const seen: unknown[] = [];
    p.onMutate((m) => seen.push(m));
    expect(p.clearSeqBank()).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('notifies per-cell listeners so panels and the BankBar both repaint', () => {
    const p = new PatternStore();
    p.setSeqStep(1, { on: true });
    p.setSeqStep(5, { on: true });
    const touched: number[] = [];
    p.onSeqChange((i) => touched.push(i));
    p.clearSeqBank();
    expect(touched).toEqual([1, 5]); // dead cells are not re-emitted
  });

  it('clearDrumTrack clears one row and leaves the rest of the bank alone', () => {
    const p = new PatternStore();
    expect(p.drum[0]!.some((c) => c.on)).toBe(true);  // seeded kick
    expect(p.drum[1]!.some((c) => c.on)).toBe(true);  // seeded snare
    expect(p.clearDrumTrack(0)).toBe(true);
    expect(p.drum[0]!.some((c) => c.on)).toBe(false);
    expect(p.drum[1]!.some((c) => c.on)).toBe(true);
  });

  it('clearDrumBank empties every track of the edit bank only', () => {
    const p = new PatternStore();
    p.copyDrumBank(0, 1);
    expect(p.clearDrumBank()).toBe(true);
    expect(p.drumBanks[0]!.every((row) => row.every((c) => !c.on))).toBe(true);
    expect(p.drumBanks[1]!.some((row) => row.some((c) => c.on))).toBe(true);
  });

  it('clearSamplerSlot / clearSamplerBank scope the same way', () => {
    const p = new PatternStore();
    p.setSamplerCell(0, 0, { on: true });
    p.setSamplerCell(1, 4, { on: true });
    expect(p.clearSamplerSlot(0)).toBe(true);
    expect(p.sampler[0]!.some((c) => c.on)).toBe(false);
    expect(p.sampler[1]![4]!.on).toBe(true);
    expect(p.clearSamplerBank()).toBe(true);
    expect(p.sampler.every((row) => row.every((c) => !c.on))).toBe(true);
  });

  it('clearMotionBank drops the anchors but keeps the bank axis override (REQ-9)', () => {
    const p = new PatternStore();
    p.setMotionStep(2, { on: true, x: 0.3, y: 0.7 });
    p.setMotionAssign({ x: 'fx.delay.mix' });
    expect(p.clearMotionBank()).toBe(true);
    expect(p.motion[2]!.on).toBe(false);
    expect(p.motion[2]!.x).toBe(0.3);                       // coordinate preserved
    expect(p.motionAssign(0)).toEqual({ x: 'fx.delay.mix' }); // config, not step data
  });
});

describe('PatternStore — extra motion tracks (motion-sequencer.md REQ-13)', () => {
  it('boots with two blank, unassigned tracks per bank', () => {
    const p = new PatternStore();
    const tracks = p.motionTracks(0);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.param).toBeUndefined();
    expect(tracks[0]!.steps).toHaveLength(SEQ_LENGTH);
    expect(tracks[0]!.steps.every((s) => !s.on)).toBe(true);
  });

  it('sets and clears a track parameter', () => {
    const p = new PatternStore();
    p.setMotionTrackParam(0, 'fx.delay.mix');
    expect(p.motionTrack(0)!.param).toBe('fx.delay.mix');
    p.setMotionTrackParam(0, null);
    expect(p.motionTrack(0)!.param).toBeUndefined();
  });

  it('tracks are per bank — assigning one bank leaves the others alone', () => {
    const p = new PatternStore();
    p.setMotionTrackParam(0, 'fx.delay.mix');
    p.setMotionEditBank(1);
    expect(p.motionTrack(0)!.param).toBeUndefined();
    expect(p.motionTracks(0)[0]!.param).toBe('fx.delay.mix');
  });

  it('clearing a track keeps its parked levels and its parameter', () => {
    const p = new PatternStore();
    p.setMotionTrackParam(0, 'fx.delay.mix');
    p.setMotionTrackStep(0, 3, { on: true, v: 0.8 });
    expect(p.clearMotionTrack(0)).toBe(true);
    expect(p.motionTrack(0)!.steps[3]!.on).toBe(false);
    expect(p.motionTrack(0)!.steps[3]!.v).toBe(0.8);
    expect(p.motionTrack(0)!.param).toBe('fx.delay.mix');
    expect(p.clearMotionTrack(0)).toBe(false); // already empty
  });

  it('copyMotionBank carries the tracks AND their params', () => {
    const p = new PatternStore();
    p.setMotionTrackParam(1, 'fx.reverb.mix');
    p.setMotionTrackStep(1, 5, { on: true, v: 0.3 });
    p.copyMotionBank(0, 2);
    const copied = p.motionTracks(2)[1]!;
    expect(copied.param).toBe('fx.reverb.mix');
    expect(copied.steps[5]).toEqual({ on: true, v: 0.3 });
    // A deep copy: editing the source must not reach the destination.
    p.setMotionTrackStep(1, 5, { v: 0.9 });
    expect(p.motionTracks(2)[1]!.steps[5]!.v).toBe(0.3);
  });

  it('tracks round-trip through snapshot/restore', () => {
    const p = new PatternStore();
    p.setMotionTrackParam(0, 'fx.delay.mix');
    p.setMotionTrackStep(0, 7, { on: true, v: 0.42 });
    const snap = p.snapshot();

    const q = new PatternStore();
    q.restore(snap);
    expect(q.motionTrack(0)!.param).toBe('fx.delay.mix');
    expect(q.motionTrack(0)!.steps[7]).toEqual({ on: true, v: 0.42 });
  });

  it('restore is authoritative — a file without tracks blanks the previous song’s', () => {
    const p = new PatternStore();
    p.setMotionTrackParam(0, 'fx.delay.mix');
    p.setMotionTrackStep(0, 1, { on: true, v: 1 });
    p.restore({ motionTracks: [[null, null], [null, null], [null, null], [null, null]] });
    expect(p.motionTrack(0)!.param).toBeUndefined();
    expect(p.motionTrack(0)!.steps[1]!.on).toBe(false);
  });

  it('a v1-v4 file (no motionTracks key) leaves the tracks untouched and blank', () => {
    const p = new PatternStore();
    p.restore({ seqBanks: [] });
    expect(p.motionTrack(0)!.param).toBeUndefined();
    expect(p.motionTrack(0)!.steps.every((s) => !s.on)).toBe(true);
  });
});

describe('emptyPatternBanks — New Song blanks the extra motion tracks (regression)', () => {
  it('returns unassigned, empty tracks for every bank', () => {
    const blank = emptyPatternBanks();
    expect(blank.motionTracks).toHaveLength(BANK_COUNT);
    for (const bank of blank.motionTracks) {
      expect(bank).toHaveLength(2);
      for (const t of bank) {
        expect(t.param).toBeUndefined();
        expect(t.steps.every((c) => !c.on)).toBe(true);
      }
    }
  });

  it('restoring it clears a previous song’s track params', () => {
    // The bug this pins: emptyPatternBanks omitted motionTracks, so restore()
    // left them alone and "New Song" kept automating the old song's params.
    const p = new PatternStore();
    p.setMotionTrackParam(0, 'fx.delay.mix');
    p.setMotionTrackStep(0, 2, { on: true, v: 1 });

    p.restore(emptyPatternBanks());
    expect(p.motionTrack(0)!.param).toBeUndefined();
    expect(p.motionTrack(0)!.steps[2]!.on).toBe(false);
  });
});
