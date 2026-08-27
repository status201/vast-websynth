import { describe, it, expect } from 'vitest';
import { formatParam } from '../../src/ui/format-param';
import { ParamBus, registerDefaults, type ParamDef } from '../../src/state/params';
import { DRUM_TRACK_COUNT, SAMPLER_SLOT_COUNT } from '../../src/state/patterns';

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

/**
 * drum-machine.md REQ-18, regression.
 *
 * `unit` looks like it labels a value and does not: `formatParam` consults only
 * `format`. A param that declared `unit: 'st'` and nothing else therefore fell
 * through to the plain numeric branch, and a knob whose whole range is whole
 * semitones read "0.00". Nothing failed — the number was simply meaningless.
 */
describe('a registered param that a knob has to show (REQ-18)', () => {
  it('ignores `unit` — only `format` reaches the readout', () => {
    // The trap itself, stated as a fact about formatParam rather than about any
    // one param: adding `unit` to a def changes nothing a user can see.
    expect(formatParam(def({ unit: 'st' }), 7)).toBe('7.00');
  });

  it('formats every drum track TUNE in semitones', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    for (let i = 0; i < DRUM_TRACK_COUNT; i++) {
      const d = bus.def(`drum.t${i}.tune`)!;
      expect(formatParam(d, 7), `drum.t${i}.tune`).toBe('+7st');
      expect(formatParam(d, -12), `drum.t${i}.tune`).toBe('-12st');
      expect(formatParam(d, 0), `drum.t${i}.tune`).toBe('+0st');
    }
  });

  it('formats every sampler slot PITCH the same way', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
      expect(formatParam(bus.def(`sampler.t${i}.pitch`)!, -5), `sampler.t${i}.pitch`).toBe('-5st');
    }
  });

  it('leaves `unit` on the def, because the generated catalogue does read it', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    expect(bus.def('drum.t0.tune')!.unit).toBe('st');
  });
});
