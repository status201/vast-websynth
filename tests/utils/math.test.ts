import { describe, it, expect } from 'vitest';
import { clamp, clamp01, midiToHz } from '../../src/utils/math';

describe('clamp', () => {
  it('passes values inside the range through', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to both bounds', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('is inclusive of the bounds themselves', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('handles negative ranges', () => {
    expect(clamp(-5, -1, 1)).toBe(-1);
    expect(clamp(0, -1, 1)).toBe(0);
  });
});

describe('clamp01', () => {
  it('passes the unit range through', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps outside the unit range', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
  });
});

describe('midiToHz', () => {
  it('anchors A4 (note 69) at 440 Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440);
  });

  it('halves/doubles per octave', () => {
    expect(midiToHz(57)).toBeCloseTo(220);
    expect(midiToHz(81)).toBeCloseTo(880);
  });

  it('maps middle C (note 60) to ~261.63 Hz', () => {
    expect(midiToHz(60)).toBeCloseTo(261.626, 2);
  });
});
