import { describe, it, expect } from 'vitest';
import {
  EQ_PRESETS, EQ_PRESET_CUSTOM, EQ_PRESET_FLAT,
  applyEqPreset, eqPresetNames, matchEqPreset, resetEq,
} from '../../src/state/eq-presets';
import {
  EQ_BAND_COUNT, EQ_GAIN_MAX, EQ_HP_REF, EQ_LP_REF, EQ_WIDTH_DEFAULT,
  readEqSettings,
} from '../../src/state/eq';
import { ParamBus, registerDefaults } from '../../src/state/params';

function freshBus(): ParamBus {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
}

describe('the preset table (equalizer.md REQ-eq-presets-are-a-table-of-bus-writes)', () => {
  it('names every band, inside the registered range', () => {
    // A preset that wrote past the param's bounds would be silently clamped, so
    // the curve you picked and the curve you got would differ.
    for (const [name, p] of Object.entries(EQ_PRESETS)) {
      expect(p.b, name).toHaveLength(EQ_BAND_COUNT);
      for (const g of p.b) {
        expect(Math.abs(g), `${name}: ${g} dB`).toBeLessThanOrEqual(EQ_GAIN_MAX);
      }
    }
  });

  it('keeps every hp/lp inside what the knob can reach', () => {
    const bus = freshBus();
    const hp = bus.def('fx.eq.hp')!;
    const lp = bus.def('fx.eq.lp')!;
    for (const [name, p] of Object.entries(EQ_PRESETS)) {
      if (p.hp !== undefined) {
        expect(p.hp, `${name}.hp`).toBeGreaterThanOrEqual(hp.min);
        expect(p.hp, `${name}.hp`).toBeLessThanOrEqual(hp.max);
      }
      if (p.lp !== undefined) {
        expect(p.lp, `${name}.lp`).toBeGreaterThanOrEqual(lp.min);
        expect(p.lp, `${name}.lp`).toBeLessThanOrEqual(lp.max);
      }
      if (p.width !== undefined) {
        const w = bus.def('fx.eq.width')!;
        expect(p.width, `${name}.width`).toBeGreaterThanOrEqual(w.min);
        expect(p.width, `${name}.width`).toBeLessThanOrEqual(w.max);
      }
    }
  });

  it('never offers Custom as something you can pick', () => {
    // It is a report, not a choice — the dropdown renders it disabled.
    expect(eqPresetNames()).not.toContain(EQ_PRESET_CUSTOM);
    expect(EQ_PRESETS[EQ_PRESET_CUSTOM]).toBeUndefined();
  });

  it('covers the shapes the feature promises', () => {
    const names = eqPresetNames();
    for (const n of ['Flat', 'Low Pass', 'High Pass', 'Band Pass', 'Hiss Removal']) {
      expect(names, n).toContain(n);
    }
    // One per named Spectrum zone — the reason the band centres are where they are.
    for (const n of ['De-Mud', 'De-Box', 'De-Nasal', 'De-Harsh']) {
      expect(names, n).toContain(n);
    }
  });
});

describe('applying a preset (REQ-eq-presets-are-a-table-of-bus-writes)', () => {
  it('writes the curve and engages the EQ', () => {
    const bus = freshBus();
    expect(bus.get('fx.drum.eq.on')).toBe(0);

    applyEqPreset(bus, 'fx.drum.eq', 'Hiss Removal');

    expect(bus.get('fx.drum.eq.on')).toBe(1);
    const s = readEqSettings(bus, 'fx.drum.eq');
    expect(s.lp).toBe(EQ_PRESETS['Hiss Removal']!.lp);
    expect(s.gains).toEqual([...EQ_PRESETS['Hiss Removal']!.b]);
  });

  it('fills in what a preset leaves out, so nothing survives from the last one', () => {
    const bus = freshBus();
    applyEqPreset(bus, 'fx.eq', 'Band Pass'); // sets hp AND lp
    applyEqPreset(bus, 'fx.eq', 'Air'); // sets neither
    const s = readEqSettings(bus, 'fx.eq');
    expect(s.hp, 'Band Pass hp leaked into Air').toBe(EQ_HP_REF);
    expect(s.lp, 'Band Pass lp leaked into Air').toBe(EQ_LP_REF);
    expect(s.width).toBe(EQ_WIDTH_DEFAULT);
  });

  it('ignores a name that is not in the table', () => {
    const bus = freshBus();
    applyEqPreset(bus, 'fx.eq', 'Not A Preset');
    expect(bus.get('fx.eq.on')).toBe(0);
  });

  it('Flat reproduces the registered defaults exactly', () => {
    const bus = freshBus();
    applyEqPreset(bus, 'fx.eq', 'De-Harsh');
    applyEqPreset(bus, 'fx.eq', EQ_PRESET_FLAT);
    const s = readEqSettings(bus, 'fx.eq');
    expect(s.gains.every((g) => g === 0)).toBe(true);
    expect(s.hp).toBe(EQ_HP_REF);
    expect(s.lp).toBe(EQ_LP_REF);
    expect(s.width).toBe(EQ_WIDTH_DEFAULT);
  });
});

describe('resetEq — the panel’s RESET (REQ-eq-presets-are-a-table-of-bus-writes)', () => {
  it('flattens the curve and leaves the switch where it was', () => {
    // One gesture, one outcome: RESET undoes a curve, it does not also switch
    // the effect on — which is the whole reason it is not `applyEqPreset(Flat)`.
    const bus = freshBus();
    applyEqPreset(bus, 'fx.eq', 'Telephone');
    expect(bus.get('fx.eq.on')).toBe(1);

    resetEq(bus, 'fx.eq');

    expect(bus.get('fx.eq.on'), 'RESET must not touch .on').toBe(1);
    const s = readEqSettings(bus, 'fx.eq');
    expect(s.gains.every((g) => g === 0)).toBe(true);
    expect(s.hp).toBe(EQ_HP_REF);
    expect(s.lp).toBe(EQ_LP_REF);
  });

  it('leaves a bypassed lane bypassed', () => {
    const bus = freshBus();
    bus.set('fx.eq.b1', -6);
    resetEq(bus, 'fx.eq');
    expect(bus.get('fx.eq.on')).toBe(0);
  });
});

describe('matchEqPreset (REQ-eq-presets-are-a-table-of-bus-writes)', () => {
  it('names the preset a lane is sitting on', () => {
    const bus = freshBus();
    for (const name of eqPresetNames()) {
      applyEqPreset(bus, 'fx.sampler.eq', name);
      expect(matchEqPreset(readEqSettings(bus, 'fx.sampler.eq')), name).toBe(name);
    }
  });

  it('falls to Custom the moment the curve is edited away from it', () => {
    const bus = freshBus();
    applyEqPreset(bus, 'fx.eq', 'De-Box');
    expect(matchEqPreset(readEqSettings(bus, 'fx.eq'))).toBe('De-Box');

    bus.set('fx.eq.b5', -4);
    expect(matchEqPreset(readEqSettings(bus, 'fx.eq'))).toBe(EQ_PRESET_CUSTOM);
  });

  it('notices a filter move as well as a band move', () => {
    const bus = freshBus();
    applyEqPreset(bus, 'fx.eq', 'Air');
    bus.set('fx.eq.hp', 200);
    expect(matchEqPreset(readEqSettings(bus, 'fx.eq'))).toBe(EQ_PRESET_CUSTOM);
  });

  it('reports the defaults as Flat, not Custom', () => {
    const bus = freshBus();
    expect(matchEqPreset(readEqSettings(bus, 'fx.eq'))).toBe(EQ_PRESET_FLAT);
  });

  it('is not fooled by export rounding', () => {
    // Songs and presets round to 4 significant figures on the way out
    // (ADR-011), so a reloaded curve is near its preset rather than equal to it.
    const bus = freshBus();
    applyEqPreset(bus, 'fx.eq', 'De-Nasal');
    bus.set('fx.eq.b3', Number((-8).toPrecision(4)));
    bus.set('fx.eq.width', Number((2).toPrecision(4)));
    expect(matchEqPreset(readEqSettings(bus, 'fx.eq'))).toBe('De-Nasal');
  });
});
