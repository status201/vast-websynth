import { describe, it, expect } from 'vitest';
import { ParamBus, registerDefaults } from '../../src/state/params';
import {
  MOD_ROWS, MOD_SOURCE_LABELS, MOD_DEST_LABELS, MOD_SRC, MOD_DST,
} from '../../src/state/mod-routing';

/**
 * specs/features/mod-matrix.md REQ-3/REQ-4 — the half of the matrix that has to be
 * true forever: the params are inert by default, and the label arrays are append-only.
 *
 * A saved route stores an **index**, so a reorder silently re-targets every preset and
 * song that predates it. That failure is invisible — the file still loads, it just
 * modulates the wrong thing — which is why it is pinned here rather than trusted.
 */
function freshBus(): ParamBus {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
}

describe('mod matrix params are inert by default (REQ-3)', () => {
  it('registers three params per free row, all at zero', () => {
    const bus = freshBus();
    for (let n = 0; n < MOD_ROWS; n++) {
      expect(bus.get(`mod.${n}.src`), `mod.${n}.src`).toBe(0);
      expect(bus.get(`mod.${n}.dst`), `mod.${n}.dst`).toBe(0);
      expect(bus.get(`mod.${n}.amt`), `mod.${n}.amt`).toBe(0);
    }
  });

  it('means off / none / silent at zero — three independent no-ops', () => {
    // Any one of the three at its default is enough to make the route silent, which
    // is what makes a partially-authored file harmless.
    expect(MOD_SOURCE_LABELS[0]).toBe('off');
    expect(MOD_DEST_LABELS[0]).toBe('none');
    expect(MOD_SRC.off).toBe(0);
    expect(MOD_DST.none).toBe(0);
  });

  it('lets amount go negative, so a route can invert (REQ-9)', () => {
    const bus = freshBus();
    expect(bus.def('mod.0.amt')?.min).toBe(-1);
    expect(bus.def('mod.0.amt')?.max).toBe(1);
  });

  it('registers src/dst over their full label range', () => {
    const bus = freshBus();
    expect(bus.def('mod.0.src')?.max).toBe(MOD_SOURCE_LABELS.length - 1);
    expect(bus.def('mod.0.dst')?.max).toBe(MOD_DEST_LABELS.length - 1);
  });

  it('adds no row beyond MOD_ROWS', () => {
    const bus = freshBus();
    expect(bus.def(`mod.${MOD_ROWS}.src`)).toBeUndefined();
  });
});

describe('the label arrays are append-only (REQ-4)', () => {
  // Spelled out, not derived: the point is that changing the source must break this
  // test, so it cannot be written in terms of the thing it guards.
  it('keeps the known source prefix in order', () => {
    expect(MOD_SOURCE_LABELS.slice(0, 9)).toEqual([
      'off', 'lfo 1', 'lfo 2', 'mod wheel', 'random', 'filter env', 'amp env', 'velocity', 'key',
    ]);
  });

  it('keeps the known destination prefix in order', () => {
    expect(MOD_DEST_LABELS.slice(0, 8)).toEqual([
      'none', 'cutoff', 'resonance', 'pitch', 'shape', 'amp', 'drive', 'pan',
    ]);
  });

  it('keeps the named indices pointing where they say', () => {
    for (const [name, i] of Object.entries(MOD_SRC)) {
      expect(MOD_SOURCE_LABELS[i], name).toBeDefined();
    }
    for (const [name, i] of Object.entries(MOD_DST)) {
      expect(MOD_DEST_LABELS[i], name).toBeDefined();
    }
  });
});

describe('a preset written before the matrix (REQ-3, back-compat)', () => {
  it('falls back to inert when the keys are absent', () => {
    const bus = freshBus();
    bus.set('mod.0.src', MOD_SRC.lfo1);
    bus.set('mod.0.dst', MOD_DST.cutoff);
    bus.set('mod.0.amt', 0.7);

    // A pre-matrix params bag simply has no mod.* keys at all.
    const legacy = Object.fromEntries(
      Object.entries(bus.snapshot()).filter(([id]) => !id.startsWith('mod.')),
    );
    bus.resetDefaults();
    bus.restore(legacy);

    expect(bus.get('mod.0.src')).toBe(0);
    expect(bus.get('mod.0.dst')).toBe(0);
    expect(bus.get('mod.0.amt')).toBe(0);
  });

  it('leaves the two LFO rows on their own params, untouched (REQ-2)', () => {
    // Rows 0-1 are grandfathered: no migration runs, so these keep their meaning.
    const bus = freshBus();
    expect(bus.def('lfo.dest')).toBeDefined();
    expect(bus.def('lfo.amount')).toBeDefined();
    expect(bus.def('mod.0.src')).toBeDefined();
    // ...and the matrix did not quietly add a duplicate depth for them.
    expect(bus.def('mod.lfo.amt')).toBeUndefined();
  });
});
