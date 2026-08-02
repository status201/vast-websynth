import { describe, it, expect } from 'vitest';
import { formatParam } from '../../src/ui/format-param';
import type { ParamDef } from '../../src/state/params';

const def = (over: Partial<ParamDef>): ParamDef => ({
  id: 'test.param', min: 0, max: 1, default: 0, ...over,
} as ParamDef);

/**
 * Pins the fallback chain lifted out of `Knob` (motion-sequencer.md REQ-22), so
 * the knobs and the motion readout keep describing a parameter identically.
 */
describe('formatParam', () => {
  it('prefers a discrete param\'s label, indexed from min', () => {
    const d = def({ taper: 'discrete', min: 1, max: 3, labels: ['LP', 'BP', 'HP'] });
    expect(formatParam(d, 1)).toBe('LP');
    expect(formatParam(d, 3)).toBe('HP');
  });

  it('falls back to the raw number when a discrete index is out of range', () => {
    const d = def({ taper: 'discrete', min: 0, max: 1, labels: ['A'] });
    expect(formatParam(d, 7)).toBe('7');
  });

  it('uses the param\'s own formatter when it has one', () => {
    expect(formatParam(def({ format: (v) => `${v.toFixed(1)}Hz` }), 2)).toBe('2.0Hz');
  });

  it('defaults to two decimals, dropping them once the magnitude reaches 100', () => {
    expect(formatParam(def({}), 0.4237)).toBe('0.42');
    expect(formatParam(def({}), -0.5)).toBe('-0.50');
    expect(formatParam(def({}), 128.6)).toBe('129');
    expect(formatParam(def({}), -100)).toBe('-100');
  });
});
