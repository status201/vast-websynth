import { describe, it, expect } from 'vitest';
import { isModDestParam, modDepthDeps, modDepthFor, modOffsetFor, modSignFor } from '../../src/state/mod-depth';
import { MOD_SRC, MOD_DST } from '../../src/state/mod-routing';
import { LFO_DEST_LABELS } from '../../src/state/params';

/**
 * specs/features/mod-matrix.md REQ-8 — how far modulation can move a knob.
 *
 * Pure, so it is tested against a plain map rather than a bus. The value of the arc is
 * that it agrees with what is *heard*, which means these numbers have to match the
 * depth table the audio layer scales its gains by — hence both read `MOD_DEST_SCALE`.
 */
function reader(vals: Record<string, number>) {
  return (id: string): number => vals[id] ?? 0;
}

const LFO_CUTOFF = LFO_DEST_LABELS.indexOf('cutoff');
const LFO_SHAPE = LFO_DEST_LABELS.indexOf('shape');
const LFO_PITCH = LFO_DEST_LABELS.indexOf('pitch');

describe('which params can show an arc', () => {
  it('names the four destinations that have a faceplate knob', () => {
    for (const id of ['filter.cutoff', 'filter.resonance', 'filter.shape', 'filter.drive']) {
      expect(isModDestParam(id), id).toBe(true);
    }
  });

  it('excludes destinations no single knob owns', () => {
    // pitch is three oscillator detunes, amp is the tremolo VCA, pan is the bus
    // panner — there is nothing to draw on.
    for (const id of ['osc1.detune', 'master.volume', 'mixer.glide', 'fx.delay.mix']) {
      expect(isModDestParam(id), id).toBe(false);
    }
  });

  it('gives an unmodulatable param no dependencies at all', () => {
    // This is what keeps ~100 faceplate knobs from subscribing to 21 params each.
    expect(modDepthDeps('master.volume')).toEqual([]);
    expect(modDepthDeps('filter.cutoff').length).toBeGreaterThan(0);
  });

  it('depends on every param that could change the answer', () => {
    const deps = modDepthDeps('filter.cutoff');
    for (const id of ['mod.0.src', 'mod.0.dst', 'mod.0.amt', 'lfo.dest', 'lfo.amount',
      'lfo2.dest', 'lfo2.amount', 'master.modWheel']) {
      expect(deps, id).toContain(id);
    }
  });
});

describe('modDepthFor', () => {
  it('is zero when nothing points at the param', () => {
    expect(modDepthFor('filter.cutoff', reader({}))).toBe(0);
  });

  it('scales a matrix route into the destination own unit', () => {
    const depth = modDepthFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 0.5,
    }));
    expect(depth).toBe(24);        // 0.5 x 48 semitones
  });

  it('ignores the sign, because a bipolar route swings both ways', () => {
    const pos = modDepthFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 0.5,
    }));
    const neg = modDepthFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': -0.5,
    }));
    expect(neg).toBe(pos);
  });

  it('ignores a route whose source is off', () => {
    expect(modDepthFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.off, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 1,
    }))).toBe(0);
  });

  it('adds two routes on one destination, as the graph does', () => {
    const depth = modDepthFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 0.5,
      'mod.1.src': MOD_SRC.random, 'mod.1.dst': MOD_DST.cutoff, 'mod.1.amt': 0.25,
    }));
    expect(depth).toBe(24 + 12);
  });

  it('keeps destinations apart', () => {
    const vals = {
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.resonance, 'mod.0.amt': 1,
    };
    expect(modDepthFor('filter.resonance', reader(vals))).toBeCloseTo(4.2, 5);
    expect(modDepthFor('filter.cutoff', reader(vals))).toBe(0);
  });

  it('uses the LFO own shallower scale for an LFO row', () => {
    // The LFO reaches +-24 semitones where a matrix route reaches +-48 (lfo.md
    // REQ-13). An arc drawn at the matrix scale would promise twice the sweep.
    const depth = modDepthFor('filter.cutoff', reader({
      'lfo.dest': LFO_CUTOFF, 'lfo.amount': 1,
    }));
    expect(depth).toBe(24);
  });

  it('counts the mod wheel, because it widens LFO 1 the same way AMT does', () => {
    const depth = modDepthFor('filter.cutoff', reader({
      'lfo.dest': LFO_CUTOFF, 'lfo.amount': 0.5, 'master.modWheel': 0.5,
    }));
    expect(depth).toBe(24);          // 0.5 + 0.5, clamped to 1, x24
  });

  it('clamps LFO 1 depth at full, as the engine does', () => {
    const depth = modDepthFor('filter.cutoff', reader({
      'lfo.dest': LFO_CUTOFF, 'lfo.amount': 1, 'master.modWheel': 1,
    }));
    expect(depth).toBe(24);          // never 48
  });

  it('does not let the mod wheel widen LFO 2', () => {
    const depth = modDepthFor('filter.cutoff', reader({
      'lfo2.dest': LFO_CUTOFF, 'lfo2.amount': 0.5, 'master.modWheel': 1,
    }));
    expect(depth).toBe(12);          // the wheel reaches LFO 1 only (lfo.md REQ-11)
  });

  it('ignores an LFO destination that owns no knob', () => {
    expect(modDepthFor('filter.cutoff', reader({
      'lfo.dest': LFO_PITCH, 'lfo.amount': 1,
    }))).toBe(0);
  });

  it('sums an LFO row and a matrix row on the same knob', () => {
    const depth = modDepthFor('filter.shape', reader({
      'lfo.dest': LFO_SHAPE, 'lfo.amount': 1,
      'mod.0.src': MOD_SRC.lfo2, 'mod.0.dst': MOD_DST.shape, 'mod.0.amt': 0.5,
    }));
    expect(depth).toBeCloseTo(0.5 + 0.5, 5);
  });
});

/**
 * REQ-11's second half: where a **main-thread-knowable** source currently has the
 * param. Only the mod wheel qualifies today — see `modOffsetFor`'s own note for why
 * the LFOs, envelopes and random do not.
 */
describe('modOffsetFor', () => {
  it('is null when no knowable source targets the param', () => {
    // Null, not 0: "nothing to draw" and "at the centre" are different states.
    expect(modOffsetFor('filter.cutoff', reader({}))).toBeNull();
    expect(modOffsetFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 1,
    }))).toBeNull();
  });

  it('tracks the wheel through the route depth', () => {
    const route = {
      'mod.0.src': MOD_SRC.modWheel, 'mod.0.dst': MOD_DST.resonance, 'mod.0.amt': 0.5,
    };
    expect(modOffsetFor('filter.resonance', reader({ ...route, 'master.modWheel': 0 }))).toBe(0);
    expect(modOffsetFor('filter.resonance', reader({ ...route, 'master.modWheel': 1 })))
      .toBeCloseTo(2.1, 5);          // 1 x 0.5 x 4.2
    expect(modOffsetFor('filter.resonance', reader({ ...route, 'master.modWheel': 0.5 })))
      .toBeCloseTo(1.05, 5);
  });

  it('is zero but NOT null with the wheel down, so the tick still shows', () => {
    const at = modOffsetFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.modWheel, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 1,
      'master.modWheel': 0,
    }));
    expect(at).toBe(0);
  });

  it('keeps the sign, so a negative route moves the tick the other way', () => {
    const off = modOffsetFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.modWheel, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': -0.5,
      'master.modWheel': 1,
    }));
    expect(off).toBe(-24);
  });

  it('does not count the wheel widening LFO 1, which the BAND already shows', () => {
    // Counting it here too would draw one gesture twice.
    expect(modOffsetFor('filter.cutoff', reader({
      'lfo.dest': LFO_CUTOFF, 'lfo.amount': 0.5, 'master.modWheel': 1,
    }))).toBeNull();
  });

  it('adds two wheel routes on one param', () => {
    const off = modOffsetFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.modWheel, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 0.25,
      'mod.1.src': MOD_SRC.modWheel, 'mod.1.dst': MOD_DST.cutoff, 'mod.1.amt': 0.25,
      'master.modWheel': 1,
    }));
    expect(off).toBe(24);
  });
});

/** REQ-13's rule: unanimous, not a sum of signs. */
describe('modSignFor', () => {
  it('is negative only when every contributing route is', () => {
    expect(modSignFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': -0.5,
    }))).toBe(-1);
  });

  it('is positive when every one is', () => {
    expect(modSignFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 0.5,
    }))).toBe(1);
  });

  it('is neutral when routes disagree, not the winner of a sum', () => {
    // "The modulation is negative" is simply not true of this knob.
    expect(modSignFor('filter.cutoff', reader({
      'mod.0.src': MOD_SRC.lfo1, 'mod.0.dst': MOD_DST.cutoff, 'mod.0.amt': 0.9,
      'mod.1.src': MOD_SRC.random, 'mod.1.dst': MOD_DST.cutoff, 'mod.1.amt': -0.1,
    }))).toBe(0);
  });

  it('is neutral when nothing points at the param', () => {
    expect(modSignFor('filter.cutoff', reader({}))).toBe(0);
  });

  it('counts an active LFO row as positive, since its depth cannot go below zero', () => {
    expect(modSignFor('filter.cutoff', reader({
      'lfo.dest': LFO_CUTOFF, 'lfo.amount': 0.5,
    }))).toBe(1);
  });
});
