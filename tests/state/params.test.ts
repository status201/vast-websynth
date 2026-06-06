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
});
