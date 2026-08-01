import { describe, it, expect } from 'vitest';
import { ParamBus, registerDefaults } from '../../src/state/params';

describe('ParamBus', () => {
  it('returns the default for a registered param', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 5 });
    expect(bus.get('a')).toBe(5);
  });

  it('clamps set values to [min, max]', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 5 });
    bus.set('a', 99);
    expect(bus.get('a')).toBe(10);
    bus.set('a', -99);
    expect(bus.get('a')).toBe(0);
  });

  it('does not notify when the clamped value is unchanged', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 5 });
    const seen: number[] = [];
    bus.subscribe('a', (v) => seen.push(v)); // immediate: [5]
    bus.set('a', 5); // unchanged → no notify
    bus.set('a', 50); // clamps to 10 → notify
    bus.set('a', 999); // clamps to 10 again → no notify
    expect(seen).toEqual([5, 10]);
  });

  it('subscribe fires immediately then on change; unsubscribe stops it', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 2 });
    const seen: number[] = [];
    const off = bus.subscribe('a', (v) => seen.push(v));
    bus.set('a', 7);
    off();
    bus.set('a', 3);
    expect(seen).toEqual([2, 7]);
  });

  it('silent set updates the value without notifying', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 0 });
    const seen: number[] = [];
    bus.subscribe('a', (v) => seen.push(v)); // [0]
    bus.set('a', 4, true);
    expect(bus.get('a')).toBe(4);
    expect(seen).toEqual([0]);
  });

  it('round-trips through snapshot/restore', () => {
    const a = new ParamBus();
    a.register({ id: 'x', min: 0, max: 100, default: 1 });
    a.register({ id: 'y', min: 0, max: 100, default: 2 });
    a.set('x', 40);
    a.set('y', 60);
    const snap = a.snapshot();

    const b = new ParamBus();
    b.register({ id: 'x', min: 0, max: 100, default: 1 });
    b.register({ id: 'y', min: 0, max: 100, default: 2 });
    b.restore(snap);
    expect(b.get('x')).toBe(40);
    expect(b.get('y')).toBe(60);
  });

  it('resetDefaults restores every registered param to its default', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    bus.set('fx.drum.delay.on', 1);
    bus.set('transport.bpm', 200);
    bus.resetDefaults();
    expect(bus.get('fx.drum.delay.on')).toBe(0);
    expect(bus.get('transport.bpm')).toBe(120);
  });

  it('onChange fires on a direct set, respects silent, and stops on unsubscribe', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 0 });
    const seen: Array<[string, number]> = [];
    const off = bus.onChange((id, v) => seen.push([id, v]));
    bus.set('a', 4);
    bus.set('a', 4); // unchanged → no fire
    bus.set('a', 7, true); // silent → no fire
    off();
    bus.set('a', 2);
    expect(seen).toEqual([['a', 4]]);
  });

  it('onChange is suppressed during bulk restore/resetDefaults applies', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 1 });
    bus.register({ id: 'b', min: 0, max: 10, default: 2 });
    const seen: string[] = [];
    bus.onChange((id) => seen.push(id));
    bus.restore({ a: 5, b: 6 }); // bulk → suppressed
    bus.resetDefaults(); // bulk → suppressed
    expect(seen).toEqual([]);
    bus.set('a', 9); // direct edit → fires
    expect(seen).toEqual(['a']);
  });

  // runtime-performance.md REQ-5 — the audio layer's door to the same
  // suppression the bulk applies above use.
  it('withoutChangeSignal withholds onChange but keeps per-param listeners', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 0 });
    const global: string[] = [];
    const perParam: number[] = [];
    bus.onChange((id) => global.push(id));
    bus.subscribe('a', (v) => perParam.push(v)); // fires immediately with 0

    bus.withoutChangeSignal(() => {
      bus.set('a', 3);
      bus.set('a', 4);
    });
    expect(global).toEqual([]);
    expect(perParam).toEqual([0, 3, 4]); // audio + UI still track every write

    bus.set('a', 5); // outside the bracket → a normal edit again
    expect(global).toEqual(['a']);
  });

  it('withoutChangeSignal nests, and a throwing body cannot wedge the counter', () => {
    const bus = new ParamBus();
    bus.register({ id: 'a', min: 0, max: 10, default: 0 });
    const global: string[] = [];
    bus.onChange((id) => global.push(id));

    bus.withoutChangeSignal(() => {
      bus.withoutChangeSignal(() => bus.set('a', 1));
      bus.set('a', 2); // still suppressed — the inner exit must not re-enable
    });
    expect(global).toEqual([]);

    expect(() => bus.withoutChangeSignal(() => { throw new Error('boom'); })).toThrow('boom');
    bus.set('a', 3);
    expect(global).toEqual(['a']); // the signal came back
  });

  describe('reset baselines', () => {
    it('reset() falls back to the registered default when no baseline is set', () => {
      const bus = new ParamBus();
      bus.register({ id: 'a', min: 0, max: 10, default: 3 });
      bus.set('a', 8);
      bus.reset('a');
      expect(bus.get('a')).toBe(3);
    });

    it('restore() records baselines so reset() returns the loaded value', () => {
      const bus = new ParamBus();
      bus.register({ id: 'a', min: 0, max: 10, default: 3 });
      bus.restore({ a: 6 });
      bus.set('a', 9);
      bus.reset('a');
      expect(bus.get('a')).toBe(6);
    });

    it('resetValue() reports the target without applying it', () => {
      const bus = new ParamBus();
      bus.register({ id: 'a', min: 0, max: 10, default: 3 });
      expect(bus.resetValue('a')).toBe(3); // default until a baseline is set
      bus.restore({ a: 6 });
      bus.set('a', 9);
      expect(bus.resetValue('a')).toBe(6);
      expect(bus.get('a')).toBe(9); // unchanged — pure query
    });

    it('setBaselines() merges: ids absent from a later snapshot keep their baseline', () => {
      const bus = new ParamBus();
      bus.register({ id: 'a', min: 0, max: 10, default: 1 });
      bus.register({ id: 'b', min: 0, max: 10, default: 2 });
      bus.setBaselines({ a: 5, b: 7 });   // e.g. a song sets both
      bus.setBaselines({ a: 9 });         // a patch-only preset sets only a
      bus.reset('a');
      bus.reset('b');
      expect(bus.get('a')).toBe(9); // updated
      expect(bus.get('b')).toBe(7); // survived the merge, not reverted to default
    });

    it('setBaselines() clamps to range and ignores unregistered ids', () => {
      const bus = new ParamBus();
      bus.register({ id: 'a', min: 0, max: 10, default: 1 });
      bus.setBaselines({ a: 99, ghost: 5 });
      expect(bus.resetValue('a')).toBe(10); // clamped
      expect(bus.resetValue('ghost')).toBe(0); // unknown id → 0, not stored
    });

    it('resetDefaults() clears baselines so reset() reverts to defaults', () => {
      const bus = new ParamBus();
      bus.register({ id: 'a', min: 0, max: 10, default: 3 });
      bus.restore({ a: 6 });
      bus.resetDefaults();
      bus.set('a', 8);
      bus.reset('a');
      expect(bus.get('a')).toBe(3);
    });

    it('setting a baseline does not fire onChange or per-param listeners', () => {
      const bus = new ParamBus();
      bus.register({ id: 'a', min: 0, max: 10, default: 1 });
      const changes: string[] = [];
      const perParam: number[] = [];
      bus.onChange((id) => changes.push(id));
      bus.subscribe('a', (v) => perParam.push(v)); // immediate: [1]
      bus.setBaselines({ a: 5 });
      expect(changes).toEqual([]);
      expect(perParam).toEqual([1]); // no extra notify from the baseline write
    });
  });

  it('dispatches note events to onNote listeners', () => {
    const bus = new ParamBus();
    const events: Array<[boolean, number, number]> = [];
    const off = bus.onNote((on, note, vel) => events.push([on, note, vel]));
    bus.noteOn(60);
    bus.noteOn(64, 0.5);
    bus.noteOff(60);
    off();
    bus.noteOn(67);
    expect(events).toEqual([
      [true, 60, 0.8],
      [true, 64, 0.5],
      [false, 60, 0],
    ]);
  });

  it('registerDefaults registers known params with their ranges', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    expect(bus.get('filter.cutoff')).toBe(90);
    const def = bus.def('filter.cutoff');
    expect(def?.min).toBe(30);
    expect(def?.max).toBe(130);
    bus.set('filter.cutoff', 999);
    expect(bus.get('filter.cutoff')).toBe(130);
    // 8 drum tracks each contribute per-track params
    expect(bus.def('drum.t7.vol')).toBeDefined();
  });

  // filter-models.md REQ-1, key-tracking.md REQ-1. All three must default to a
  // no-op or every existing preset, demo and share link changes sound (ADR-006).
  it('registers the filter model, shape and keytrack as no-ops', () => {
    const bus = new ParamBus();
    registerDefaults(bus);

    expect(bus.get('filter.model')).toBe(0); // 0 = ladder, the pre-existing filter
    expect(bus.get('filter.shape')).toBe(0); // 0 = LP24, a plain 4-pole low-pass
    expect(bus.get('filter.keytrack')).toBe(0);

    const model = bus.def('filter.model');
    expect(model?.taper).toBe('discrete');
    expect(model?.labels).toEqual(['ladder', 'poly']);
    expect(model?.max).toBe(1);

    bus.set('filter.model', 9);
    expect(bus.get('filter.model')).toBe(1); // clamped, not wrapped
    bus.set('filter.shape', 2);
    expect(bus.get('filter.shape')).toBe(1);
  });

  it('names the shape morph after the anchor it is nearest', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const fmt = bus.def('filter.shape')?.format;
    expect(fmt?.(0)).toBe('LP24');
    expect(fmt?.(1 / 3)).toBe('LP12');
    expect(fmt?.(2 / 3)).toBe('BP12');
    expect(fmt?.(1)).toBe('HP24');
  });

  it('appends the shape LFO destination without moving the older indices', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const def = bus.def('lfo.dest');
    // An index here is a stored value in every saved patch (lfo.md REQ-3).
    expect(def?.labels).toEqual(['off', 'cutoff', 'pitch', 'amp', 'pulse', 'pan', 'shape']);
    expect(def?.max).toBe(6);
    bus.set('lfo.dest', 7);
    expect(bus.get('lfo.dest')).toBe(6);
  });

  it('registers the drum reverb params with off-by-default bypass', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    expect(bus.get('fx.drum.reverb.on')).toBe(0); // legacy songs load with drums dry
    expect(bus.get('fx.drum.reverb.size')).toBe(0.6);
    expect(bus.get('fx.drum.reverb.damp')).toBe(0.4);
    expect(bus.get('fx.drum.reverb.mix')).toBe(0.25);
    bus.set('fx.drum.reverb.on', 1);
    expect(bus.get('fx.reverb.on')).toBe(0); // distinct from the synth reverb
  });

  it('registers per-track tone/drive/pan with no-op defaults for every drum track', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    for (let i = 0; i < 8; i++) {
      expect(bus.def(`drum.t${i}.tone`)?.default).toBe(1); // open
      expect(bus.def(`drum.t${i}.drive`)?.default).toBe(0); // clean
      expect(bus.def(`drum.t${i}.pan`)?.default).toBe(0); // centre
    }
  });
});
