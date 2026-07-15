import { describe, it, expect, vi } from 'vitest';
import { createEffectiveXy } from '../../src/state/xy-effective';
import { XyPadStore, XY_DEFAULT_ASSIGN } from '../../src/state/xy-pad';
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
