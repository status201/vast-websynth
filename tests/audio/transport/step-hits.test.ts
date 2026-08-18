import { describe, it, expect } from 'vitest';
import {
  rollProb, stepHits, chokeAt, forEachActiveHit, microOffset, MAX_EARLY_S,
} from '../../../src/audio/transport/step-hits';
import type { StepHit } from '../../../src/audio/transport/step-hits';
import type { TriggerCell } from '../../../src/state/patterns';
import { MICRO_MAX, MICRO_UNITS } from '../../../src/state/limits';

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
    on: true, velocity: 0.85, gate: 1, prob: 1, ratchet: 1, tie: false, micro: 0, ...over,
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

describe('microOffset (step-settings.md REQ-6/REQ-7/REQ-9)', () => {
  /** A 16th at 125 BPM: 0.12 s. Half of it is exactly MAX_EARLY_S, so the full
   *  micro range is representable here and the cap never bites. */
  const CELL_125 = 0.12;

  it('is exactly 0 at micro 0, changing nothing about a pre-v3 step', () => {
    expect(microOffset({ micro: 0 }, CELL_125)).toBe(0);
    // Object.is, so it is +0 and not -0 — an offset added to `when` must not
    // perturb the value at all.
    expect(Object.is(microOffset({ micro: 0 }, CELL_125), 0)).toBe(true);
  });

  it('moves a step by 1/24 of its cell per notch, signed', () => {
    expect(microOffset({ micro: 6 }, CELL_125)).toBeCloseTo(CELL_125 / 4, 12);
    expect(microOffset({ micro: -6 }, CELL_125)).toBeCloseTo(-CELL_125 / 4, 12);
    expect(microOffset({ micro: 1 }, CELL_125)).toBeCloseTo(CELL_125 / MICRO_UNITS, 12);
  });

  it('is a fraction of the LANE cell, so a longer cell moves further in seconds', () => {
    const slow = microOffset({ micro: 3 }, CELL_125 * 2);
    expect(slow).toBeCloseTo(microOffset({ micro: 3 }, CELL_125) * 2, 12);
  });

  it('reaches exactly half a cell at the range ends (REQ-7)', () => {
    expect(microOffset({ micro: MICRO_MAX }, CELL_125)).toBeCloseTo(CELL_125 / 2, 12);
    expect(microOffset({ micro: -MICRO_MAX }, CELL_125)).toBeCloseTo(-CELL_125 / 2, 12);
  });

  it('lets neighbouring steps MEET but never CROSS — the ordering invariant (REQ-7)', () => {
    // Step n pushed fully late vs. step n+1 pulled fully early: the worst case.
    const nLate = 0 + microOffset({ micro: MICRO_MAX }, CELL_125);
    const nextEarly = CELL_125 + microOffset({ micro: -MICRO_MAX }, CELL_125);
    expect(nextEarly).toBeCloseTo(nLate, 12);
    expect(nextEarly).toBeGreaterThanOrEqual(nLate - 1e-12);

    // ...and for every representable pair, not just the extreme.
    for (let a = -MICRO_MAX; a <= MICRO_MAX; a++) {
      for (let b = -MICRO_MAX; b <= MICRO_MAX; b++) {
        const first = microOffset({ micro: a }, CELL_125);
        const second = CELL_125 + microOffset({ micro: b }, CELL_125);
        expect(second).toBeGreaterThanOrEqual(first - 1e-12);
      }
    }
  });

  it('caps an EARLY offset at MAX_EARLY_S so nothing is scheduled into the past (REQ-9)', () => {
    const slowCell = 0.75; // a 16th at 20 BPM — half of it is 375 ms
    expect(microOffset({ micro: -MICRO_MAX }, slowCell)).toBe(-MAX_EARLY_S);
    // A shallow nudge at the same tempo is still exact — the cap is a ceiling,
    // not a rescaling.
    expect(microOffset({ micro: -1 }, slowCell)).toBeCloseTo(-slowCell / MICRO_UNITS, 12);
  });

  it('never caps a LATE offset — a later time is always schedulable (REQ-9)', () => {
    const slowCell = 0.75;
    expect(microOffset({ micro: MICRO_MAX }, slowCell)).toBeCloseTo(slowCell / 2, 12);
    expect(microOffset({ micro: MICRO_MAX }, slowCell)).toBeGreaterThan(MAX_EARLY_S);
  });
});

describe('forEachActiveHit + micro', () => {
  const cell = (over: Partial<TriggerCell> = {}): TriggerCell => ({
    on: true, velocity: 0.85, gate: 1, prob: 1, ratchet: 1, tie: false, micro: 0, ...over,
  });

  const times = (bank: TriggerCell[][], stepDur = 0.24): number[] => {
    const out: number[] = [];
    forEachActiveHit(bank, 0, 1, stepDur, bank.map(() => false), (_l, hit) => out.push(hit.t));
    return out;
  };

  it('offsets each lane independently — the point of PER-STEP micro (REQ-8)', () => {
    const [straight, late, early] = times([[cell()], [cell({ micro: 6 })], [cell({ micro: -6 })]]);
    expect(straight).toBe(1);
    expect(late).toBeCloseTo(1 + 0.06, 12);
    expect(early).toBeCloseTo(1 - 0.06, 12);
  });

  it('carries the ratchet sub-hits and the gate with it', () => {
    const out: { t: number; gateEnd: number }[] = [];
    forEachActiveHit([[cell({ micro: 6, ratchet: 2, gate: 0.5 })]], 0, 1, 0.24, [false],
      (_l, hit) => out.push({ t: hit.t, gateEnd: hit.gateEnd }));
    // Both sub-hits shift by the same offset, and each gate end follows its hit.
    expect(out[0]!.t).toBeCloseTo(1.06, 12);
    expect(out[1]!.t).toBeCloseTo(1.06 + 0.12, 12);
    expect(out[0]!.gateEnd).toBeCloseTo(out[0]!.t + 0.06, 12);
  });

  it('leaves a micro-0 bank bit-identical to the pre-v3 behaviour (regression)', () => {
    expect(times([[cell()], [cell()]])).toEqual([1, 1]);
  });
});
