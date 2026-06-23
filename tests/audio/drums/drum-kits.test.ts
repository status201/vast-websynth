import { describe, it, expect } from 'vitest';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import {
  DRUM_KITS,
  KIT_PARAMS,
  applyKit,
  randomKitValues,
  randomizeKit,
} from '../../../src/audio/drums/drum-kits';
import { DRUM_TRACK_COUNT } from '../../../src/state/patterns';

function freshBus(): ParamBus {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
}

describe('drum kits', () => {
  it('every kit table has DRUM_TRACK_COUNT entries per param it sets', () => {
    for (const [name, kit] of Object.entries(DRUM_KITS)) {
      for (const p of KIT_PARAMS) {
        const arr = kit[p];
        if (arr) expect(arr.length, `${name}.${p}`).toBe(DRUM_TRACK_COUNT);
      }
    }
  });

  it('Default kit reproduces the registered defaults (no-op)', () => {
    const bus = freshBus();
    bus.set('drum.t0.tune', 7);
    bus.set('drum.t3.drive', 0.5);
    applyKit(bus, 'Default');
    for (let i = 0; i < DRUM_TRACK_COUNT; i++) {
      for (const p of KIT_PARAMS) {
        const id = `drum.t${i}.${p}`;
        expect(bus.get(id)).toBe(bus.def(id)!.default);
      }
    }
  });

  it('applyKit writes the kit value where given and the default otherwise', () => {
    const bus = freshBus();
    applyKit(bus, '808');
    // 808 tunes the kick down but does not set vol, which stays default.
    expect(bus.get('drum.t0.tune')).toBe(DRUM_KITS['808']!.tune![0]);
    expect(bus.get('drum.t0.vol')).toBe(bus.def('drum.t0.vol')!.default);
  });

  it('applyKit on an unknown name is a no-op', () => {
    const bus = freshBus();
    bus.set('drum.t0.tune', 5);
    applyKit(bus, 'NoSuchKit');
    expect(bus.get('drum.t0.tune')).toBe(5);
  });

  it('randomKitValues covers every track × param and stays in musical range', () => {
    const seq = [0, 0.25, 0.5, 0.75, 1];
    let i = 0;
    const rand = (): number => seq[i++ % seq.length]!;
    const vals = randomKitValues(rand);
    expect(Object.keys(vals).length).toBe(DRUM_TRACK_COUNT * KIT_PARAMS.length);
    for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
      expect(Math.abs(vals[`drum.t${t}.tune`]!)).toBeLessThanOrEqual(7);
      expect(vals[`drum.t${t}.decay`]!).toBeGreaterThanOrEqual(0.1);
      expect(vals[`drum.t${t}.decay`]!).toBeLessThanOrEqual(0.6);
      expect(vals[`drum.t${t}.tone`]!).toBeGreaterThanOrEqual(0.4);
      expect(vals[`drum.t${t}.tone`]!).toBeLessThanOrEqual(1);
      expect(vals[`drum.t${t}.drive`]!).toBeGreaterThanOrEqual(0);
      expect(vals[`drum.t${t}.drive`]!).toBeLessThanOrEqual(0.4);
      expect(Math.abs(vals[`drum.t${t}.pan`]!)).toBeLessThanOrEqual(0.6);
    }
  });

  it('randomizeKit applies the rolled values to the bus', () => {
    const bus = freshBus();
    expect(bus.get('drum.t0.drive')).toBe(0); // no-op default
    randomizeKit(bus, () => 1); // top of every range
    expect(bus.get('drum.t0.drive')).toBeCloseTo(0.4);
    expect(bus.get('drum.t0.tune')).toBe(7);
  });
});
