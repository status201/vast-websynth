import { describe, it, expect, vi } from 'vitest';
import { createEffectiveXy, motionAxesFor, motionAxesInto, motionAxesMatch } from '../../src/state/xy-effective';
import { XyPadStore, XY_DEFAULT_ASSIGN, type XyAssign } from '../../src/state/xy-pad';
import { PatternStore } from '../../src/state/patterns';
import { ParamBus, registerDefaults } from '../../src/state/params';

/** Manual stand-in for the Arrangement's motion-lane slice. */
function fakeLane() {
  const listeners = new Set<() => void>();
  return {
    motionPlayBank: 0,
    onChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
    notify() { for (const l of listeners) l(); },
  };
}

function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const xy = new XyPadStore();
  const patterns = new PatternStore();
  const lane = fakeLane();
  const eff = createEffectiveXy(xy, patterns, lane, bus);
  return { bus, xy, patterns, lane, eff };
}

describe('createEffectiveXy (motion-sequencer.md REQ-11)', () => {
  it('resolves to the base assignment while motion is off, even with an override', () => {
    const { patterns, eff } = build();
    patterns.setMotionAssign({ x: 'fx.delay.time', y: 'fx.delay.mix' });
    expect(eff.get()).toEqual(XY_DEFAULT_ASSIGN);
  });

  it('the play bank override wins per axis while motion is on', () => {
    const { bus, patterns, eff } = build();
    bus.set('motion.on', 1);
    patterns.setMotionAssign({ x: 'fx.delay.time' }); // y unset -> base
    expect(eff.get()).toEqual({ x: 'fx.delay.time', y: XY_DEFAULT_ASSIGN.y });
  });

  it('emits when the play bank crosses into a bank with a different override', () => {
    const { bus, patterns, lane, eff } = build();
    bus.set('motion.on', 1);
    patterns.setMotionEditBank(1);
    patterns.setMotionAssign({ y: 'lfo.rate' });
    patterns.setMotionEditBank(0);
    const seen: unknown[] = [];
    eff.onChange((a) => seen.push(a));
    lane.motionPlayBank = 1; // the chain advanced to bank B
    lane.notify();
    expect(seen).toEqual([{ x: XY_DEFAULT_ASSIGN.x, y: 'lfo.rate' }]);
    expect(eff.get()).toEqual({ x: XY_DEFAULT_ASSIGN.x, y: 'lfo.rate' });
  });

  it('emits on override edits, base reassignment, and motion.on toggles', () => {
    const { bus, xy, patterns, eff } = build();
    const cb = vi.fn();
    eff.onChange(cb);
    bus.set('motion.on', 1);            // on, but no override -> effective unchanged
    expect(cb).not.toHaveBeenCalled();
    patterns.setMotionAssign({ x: 'fx.delay.time' });
    expect(cb).toHaveBeenLastCalledWith({ x: 'fx.delay.time', y: XY_DEFAULT_ASSIGN.y });
    xy.set({ y: 'lfo.amount' });        // base change flows through the fallback axis
    expect(cb).toHaveBeenLastCalledWith({ x: 'fx.delay.time', y: 'lfo.amount' });
    bus.set('motion.on', 0);            // off -> back to base on both axes
    expect(cb).toHaveBeenLastCalledWith({ x: XY_DEFAULT_ASSIGN.x, y: 'lfo.amount' });
  });

  it('muting falls back to the base assignment; unmuting restores the override (REQ-12)', () => {
    const { bus, patterns, eff } = build();
    bus.set('motion.on', 1);
    patterns.setMotionAssign({ x: 'fx.delay.time' });
    const cb = vi.fn();
    eff.onChange(cb);
    bus.set('motion.mute', 1); // muted machine is inactive -> base axes
    expect(cb).toHaveBeenLastCalledWith(XY_DEFAULT_ASSIGN);
    expect(eff.get()).toEqual(XY_DEFAULT_ASSIGN);
    bus.set('motion.mute', 0);
    expect(cb).toHaveBeenLastCalledWith({ x: 'fx.delay.time', y: XY_DEFAULT_ASSIGN.y });
  });

  it('does not emit when a change leaves the effective pair identical', () => {
    const { lane, eff } = build();
    const cb = vi.fn();
    eff.onChange(cb);
    lane.notify(); // bar advance with no overrides anywhere
    expect(cb).not.toHaveBeenCalled();
  });
});

/**
 * The allocation-free companion to `motionAxesFor`, used by the motion machine's
 * per-frame carry gate (runtime-performance.md REQ-6). It must answer exactly
 * what comparing `motionAxesFor(...)` field-by-field would — that is the whole
 * reason the two live in one file.
 */
describe('motionAxesInto', () => {
  const base: XyAssign = { x: 'filter.cutoff', y: 'filter.resonance' };

  it('agrees with motionAxesFor for every bank, override and axis (the contract)', () => {
    const p = new PatternStore();
    p.setMotionEditBank(1);
    p.setMotionAssign({ x: 'fx.delay.time' });          // partial override
    p.setMotionEditBank(2);
    p.setMotionAssign({ x: 'fx.delay.time', y: 'fx.reverb.mix' }); // both axes
    const out: XyAssign = { x: '', y: '' };
    for (const bank of [0, 1, 2, 3]) {
      motionAxesInto(p, bank, base, out);
      expect({ x: out.x, y: out.y }).toEqual(motionAxesFor(p, bank, base));
    }
  });

  it('overwrites both fields, so a reused holder never leaks the last bank', () => {
    const p = new PatternStore();
    p.setMotionEditBank(1);
    p.setMotionAssign({ x: 'fx.delay.time', y: 'fx.reverb.mix' });
    const out: XyAssign = { x: 'stale.x', y: 'stale.y' };
    motionAxesInto(p, 0, base, out);           // bank 0 has no override
    expect(out).toEqual(base);
  });
});

describe('motionAxesMatch', () => {
  const base: XyAssign = { x: 'filter.cutoff', y: 'filter.resonance' };

  /** The definition it has to agree with, spelled out. */
  const viaMotionAxesFor = (p: PatternStore, bank: number, axes: XyAssign): boolean => {
    const a = motionAxesFor(p, bank, base);
    return a.x === axes.x && a.y === axes.y;
  };

  it('matches when the bank has no override and the axes are the base', () => {
    const p = new PatternStore();
    expect(motionAxesMatch(p, 0, base, base)).toBe(true);
    expect(motionAxesMatch(p, 0, base, { x: 'fx.delay.time', y: base.y })).toBe(false);
  });

  it('honours a partial override per axis, like motionAxesFor', () => {
    const p = new PatternStore();
    p.setMotionEditBank(1);
    p.setMotionAssign({ x: 'fx.delay.time' }); // y falls back to base
    expect(motionAxesMatch(p, 1, base, { x: 'fx.delay.time', y: base.y })).toBe(true);
    expect(motionAxesMatch(p, 1, base, base)).toBe(false);
  });

  it('agrees with motionAxesFor across every combination (the contract)', () => {
    const p = new PatternStore();
    p.setMotionEditBank(2);
    p.setMotionAssign({ x: 'fx.delay.time', y: 'fx.reverb.mix' });
    const candidates: XyAssign[] = [
      base,
      { x: 'fx.delay.time', y: 'fx.reverb.mix' },
      { x: 'fx.delay.time', y: base.y },
      { x: base.x, y: 'fx.reverb.mix' },
    ];
    for (const bank of [0, 1, 2, 3]) {
      for (const axes of candidates) {
        expect(motionAxesMatch(p, bank, base, axes)).toBe(viaMotionAxesFor(p, bank, axes));
      }
    }
  });
});
