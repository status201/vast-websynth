import { describe, it, expect } from 'vitest';
import { toNorm, fromNorm } from '../../src/ui/components/taper';
import type { ParamDef } from '../../src/state/params';

const def = (over: Partial<ParamDef>): ParamDef => ({
  id: 'test', min: 0, max: 1, default: 0, ...over,
});

describe('taper mappings', () => {
  describe('linear (default)', () => {
    const d = def({ min: 0, max: 10 });
    it('maps proportionally', () => {
      expect(fromNorm(d, 0.5)).toBeCloseTo(5);
      expect(toNorm(d, 5)).toBeCloseTo(0.5);
    });
    it('clamps the normalized input', () => {
      expect(fromNorm(d, -1)).toBe(0);
      expect(fromNorm(d, 2)).toBe(10);
    });
  });

  describe('exp', () => {
    const d = def({ min: 20, max: 20000, taper: 'exp' });
    it('is geometric and round-trips', () => {
      const mid = fromNorm(d, 0.5);
      expect(mid).toBeCloseTo(Math.sqrt(20 * 20000)); // geometric mean
      expect(toNorm(d, mid)).toBeCloseTo(0.5);
    });
  });

  describe('power (filter.resonance shape)', () => {
    const d = def({ min: 0, max: 4.2, taper: 'power', curve: 0.6 });

    it('puts the knob midpoint above the linear midpoint (finer near max)', () => {
      const mid = fromNorm(d, 0.5);
      expect(mid).toBeGreaterThan(0.5 * 4.2); // > linear 2.1
      expect(mid).toBeCloseTo(4.2 * Math.pow(0.5, 0.6));
    });

    it('round-trips value → norm → value across the range', () => {
      for (const v of [0, 0.5, 1.5, 2.5, 3.7, 4.2]) {
        expect(fromNorm(d, toNorm(d, v))).toBeCloseTo(v);
      }
    });

    it('keeps the endpoints exact', () => {
      expect(fromNorm(d, 0)).toBeCloseTo(0);
      expect(fromNorm(d, 1)).toBeCloseTo(4.2);
      expect(toNorm(d, 0)).toBeCloseTo(0);
      expect(toNorm(d, 4.2)).toBeCloseTo(1);
    });

    it('curve defaults to 1 (≡ linear) when omitted', () => {
      const lin = def({ min: 0, max: 4.2, taper: 'power' });
      expect(fromNorm(lin, 0.5)).toBeCloseTo(2.1);
    });
  });

  it('snaps to step when defined', () => {
    const d = def({ min: 0, max: 4, step: 1 });
    expect(fromNorm(d, 0.4)).toBe(2); // 0.4*4 = 1.6 → round to 2
  });
});
