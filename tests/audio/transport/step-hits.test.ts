import { describe, it, expect } from 'vitest';
import { rollProb, stepHits, chokeAt } from '../../../src/audio/transport/step-hits';

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
