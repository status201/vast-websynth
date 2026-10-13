/**
 * The master volume law and the knob readout that must agree with it
 * (input-control.md REQ-cc11-is-expression, REQ-the-volume-knob-reads-the-gain-it-applies).
 */
import { describe, it, expect } from 'vitest';
import { masterLevel } from '../../src/state/master-level';
import { ParamBus, registerDefaults } from '../../src/state/params';

describe('masterLevel', () => {
  it('is volume squared at expression 1', () => {
    expect(masterLevel(0.5, 1)).toBe(0.25);
    expect(masterLevel(1, 1)).toBe(1);
    expect(masterLevel(0, 1)).toBe(0);
  });

  it('multiplies in expression on the same squared law', () => {
    expect(masterLevel(0.8, 0.5)).toBeCloseTo(0.16, 12);
  });
});

describe('master.volume readout', () => {
  // The shipped def, not a copy of its formatter: the bug was the def's own format.
  const bus = new ParamBus();
  registerDefaults(bus);
  const fmt = (v: number): string => {
    const f = bus.def('master.volume')?.format;
    if (!f) throw new Error('master.volume has no formatter');
    return f(v);
  };

  it('reads the gain the engine applies, not the knob position', () => {
    // 0.5 is a quarter of the gain — -12 dB, not the -6 dB the position suggests.
    expect(fmt(0.5)).toBe('-12.0dB');
    expect(20 * Math.log10(masterLevel(0.5, 1))).toBeCloseTo(-12.04, 2);
    expect(fmt(0.8)).toBe('-3.9dB');
    expect(fmt(1)).toBe('0.0dB');
  });

  it('floors silence at -120 dB rather than printing -Infinity', () => {
    expect(fmt(0)).toBe('-120.0dB');
  });
});
