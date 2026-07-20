import { describe, it, expect } from 'vitest';
import { rollProb, stepHits, chokeAt, forEachActiveHit } from '../../../src/audio/transport/step-hits';
import type { StepHit } from '../../../src/audio/transport/step-hits';
import type { TriggerCell } from '../../../src/state/patterns';

describe('rollProb', () => {
  it('always fires at prob 1 without consulting the rng', () => {
    let calls = 0;
    expect(rollProb(1, () => { calls++; return 0.99; })).toBe(true);
    expect(calls).toBe(0);
  });

  it('fires when the roll is at or below prob, skips above it', () => {
    expect(rollProb(0.5, () => 0.5)).toBe(true);  // rng === prob → fire
    expect(rollProb(0.5, () => 0.51)).toBe(false);
    expect(rollProb(0.5, () => 0.1)).toBe(true);
  });

  it('never fires at prob 0 (except a roll of exactly 0)', () => {
    expect(rollProb(0, () => 0.0001)).toBe(false);
  });
});

describe('stepHits', () => {
  const base = { gate: 0.5, ratchet: 1, tie: false };

  it('produces one full-step hit for ratchet 1', () => {
    const hits = stepHits(base, 2, 0.125);
    expect(hits).toEqual([{ t: 2, gateEnd: 2 + 0.125 * 0.5, holds: false }]);
  });

  it('spaces ratchet sub-hits evenly with per-sub gate ends', () => {
    const hits = stepHits({ ...base, ratchet: 4 }, 1, 0.2);
    const sub = 0.2 / 4;
    expect(hits.map((h) => h.t)).toEqual([1, 1 + sub, 1 + 2 * sub, 1 + 3 * sub]);
    for (const h of hits) expect(h.gateEnd).toBeCloseTo(h.t + sub * 0.5);
  });

  it('clamps and rounds the ratchet count', () => {
    expect(stepHits({ ...base, ratchet: 0 }, 0, 0.1)).toHaveLength(1);
    expect(stepHits({ ...base, ratchet: 2.6 }, 0, 0.1)).toHaveLength(3);
  });

  it('marks only the last sub-hit as holding when tied', () => {
    const hits = stepHits({ ...base, ratchet: 3, tie: true }, 0, 0.3);
    expect(hits.map((h) => h.holds)).toEqual([false, false, true]);
    expect(stepHits(base, 0, 0.3).map((h) => h.holds)).toEqual([false]);
  });
});

describe('chokeAt', () => {
  it('returns the gate end for a shortened gate', () => {
    expect(chokeAt({ gate: 0.5 }, { t: 1, gateEnd: 1.05, holds: false })).toBe(1.05);
  });

  it('returns undefined at gate 1 (natural decay)', () => {
    expect(chokeAt({ gate: 1 }, { t: 1, gateEnd: 1.1, holds: false })).toBeUndefined();
  });

  it('returns undefined for a holding (tied last) hit even when the gate is short', () => {
    expect(chokeAt({ gate: 0.25 }, { t: 1, gateEnd: 1.025, holds: true })).toBeUndefined();
  });
});

describe('forEachActiveHit', () => {
  const cell = (over: Partial<TriggerCell> = {}): TriggerCell => ({
    on: true, velocity: 0.85, gate: 1, prob: 1, ratchet: 1, tie: false, ...over,
  });
  const off = cell({ on: false });

  /** Collect (lane, hit, cell) triples so order and content are both assertable. */
  const collect = (
    bank: TriggerCell[][],
    muted: boolean[],
    idx = 0,
  ): { lane: number; hit: StepHit; cell: TriggerCell }[] => {
    const out: { lane: number; hit: StepHit; cell: TriggerCell }[] = [];
    forEachActiveHit(bank, idx, 1, 0.25, muted, (lane, hit, c) => out.push({ lane, hit, cell: c }));
    return out;
  };

  it('fires one hit per active lane, in lane order', () => {
    const hits = collect([[cell()], [cell()], [cell()]], [false, false, false]);
    expect(hits.map((h) => h.lane)).toEqual([0, 1, 2]);
    expect(hits.every((h) => h.hit.t === 1)).toBe(true);
  });

  it('skips muted lanes', () => {
    const hits = collect([[cell()], [cell()], [cell()]], [false, true, false]);
    expect(hits.map((h) => h.lane)).toEqual([0, 2]);
  });

  it('skips lanes whose cell is off or absent', () => {
    const hits = collect([[off], [cell()], []], [false, false, false]);
    expect(hits.map((h) => h.lane)).toEqual([1]);
  });

  it('never fires at prob 0 and always fires at prob 1', () => {
    expect(collect([[cell({ prob: 0 })]], [false])).toHaveLength(0);
    expect(collect([[cell({ prob: 1 })]], [false])).toHaveLength(1);
  });

  it('expands ratchets into evenly-spaced sub-hits on one lane', () => {
    const hits = collect([[cell({ ratchet: 4 })]], [false]);
    expect(hits).toHaveLength(4);
    expect(hits.map((h) => h.hit.t)).toEqual([1, 1.0625, 1.125, 1.1875]);
    expect(hits.every((h) => h.lane === 0)).toBe(true);
  });

  it('passes the originating cell through to fire', () => {
    const c = cell({ velocity: 0.4 });
    expect(collect([[c]], [false])[0]!.cell).toBe(c);
  });

  it('bounds the sweep by muted.length, ignoring extra bank rows', () => {
    const hits = collect([[cell()], [cell()], [cell()]], [false, false]);
    expect(hits.map((h) => h.lane)).toEqual([0, 1]);
  });

  it('reads the given step index across the bank', () => {
    const hits = collect([[off, cell()], [cell(), off]], [false, false], 1);
    expect(hits.map((h) => h.lane)).toEqual([0]);
  });
});
