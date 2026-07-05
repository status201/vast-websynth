import { describe, it, expect, vi } from 'vitest';
import { XyPadStore, XY_DEFAULT_ASSIGN } from '../../src/state/xy-pad';

describe('XyPadStore', () => {
  it('defaults to cutoff x resonance', () => {
    expect(new XyPadStore().get()).toEqual(XY_DEFAULT_ASSIGN);
    expect(XY_DEFAULT_ASSIGN).toEqual({ x: 'filter.cutoff', y: 'filter.resonance' });
  });

  it('get() returns a copy — mutating it never touches the store', () => {
    const s = new XyPadStore();
    const a = s.get();
    a.x = 'lfo.rate';
    expect(s.get().x).toBe('filter.cutoff');
  });

  it('set() merges a partial assignment', () => {
    const s = new XyPadStore();
    s.set({ x: 'lfo.rate' });
    expect(s.get()).toEqual({ x: 'lfo.rate', y: 'filter.resonance' });
    s.set({ y: 'master.volume' });
    expect(s.get()).toEqual({ x: 'lfo.rate', y: 'master.volume' });
  });

  it('notifies subscribers on a real change, with a snapshot copy', () => {
    const s = new XyPadStore();
    const seen: unknown[] = [];
    s.onChange((a) => seen.push(a));
    s.set({ x: 'lfo.rate' });
    expect(seen).toEqual([{ x: 'lfo.rate', y: 'filter.resonance' }]);
  });

  it('does NOT notify when set() changes nothing', () => {
    const s = new XyPadStore();
    const cb = vi.fn();
    s.onChange(cb);
    s.set({ x: 'filter.cutoff' });   // same as default
    s.set({});                        // empty partial
    expect(cb).not.toHaveBeenCalled();
  });

  it('onChange returns an unsubscribe', () => {
    const s = new XyPadStore();
    const cb = vi.fn();
    const off = s.onChange(cb);
    off();
    s.set({ x: 'lfo.rate' });
    expect(cb).not.toHaveBeenCalled();
  });
});
