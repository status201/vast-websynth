import { describe, it, expect } from 'vitest';
import { MotionMachine } from '../../../src/audio/transport/motion-machine';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import { PatternStore, SEQ_LENGTH } from '../../../src/state/patterns';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { XyPadStore } from '../../../src/state/xy-pad';
import { fromNorm } from '../../../src/utils/taper';
import { TestClock } from './test-clock';

/**
 * MotionMachine against a real ParamBus + Arrangement and the synchronous
 * TestClock. The rAF loop is bypassed: tests drive `frame(now)` directly
 * (the loop's only job is calling it), with no-op raf/caf injected.
 */
function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  const clock = new TestClock();
  const arrangement = new Arrangement(patterns, clock);
  const xy = new XyPadStore(); // defaults: x=filter.cutoff, y=filter.resonance
  const machine = new MotionMachine(clock, patterns, arrangement, xy, bus, {
    raf: () => 0,
    caf: () => {},
  });
  return { bus, patterns, clock, arrangement, xy, machine };
}

/** Set an anchor on the edit bank. */
function anchor(patterns: PatternStore, step: number, x: number, y: number): void {
  patterns.setMotionStep(step, { on: true, x, y });
}

const STEP_DUR = 60 / 120 / 4; // TestClock default BPM

describe('MotionMachine', () => {
  it('does nothing while disabled or when the bank has no anchors', () => {
    const { bus, patterns, clock, machine } = build();
    const before = bus.get('filter.cutoff');
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);           // disabled
    machine.setEnabled(true);
    machine.frame(0);           // enabled but empty bank
    expect(bus.get('filter.cutoff')).toBe(before);
    anchor(patterns, 0, 0.5, 0.5);
    machine.frame(0);           // now it writes
    expect(bus.get('filter.cutoff')).not.toBe(before);
  });

  it('step mode writes the anchor value at the step and holds it', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    machine.setSlide(false);
    anchor(patterns, 0, 0, 0);      // norm 0 on both axes
    anchor(patterns, 8, 1, 1);      // norm 1
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    const defX = bus.def('filter.cutoff')!;
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0));
    // Mid-gap: still the step-0 value.
    machine.frame(4 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0));
    // Past the step-8 anchor (the tick advances the position reference).
    for (let i = 1; i <= 8; i++) clock.fireTick(i * STEP_DUR);
    machine.frame(8 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 1));
  });

  it('slide mode interpolates between anchors at sub-step times', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    anchor(patterns, 0, 0, 0);
    anchor(patterns, 8, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    // Halfway to step 8 (4 steps after tick 0) → norm 0.5 on both axes.
    machine.frame(4 * STEP_DUR);
    const defX = bus.def('filter.cutoff')!;
    const defY = bus.def('filter.resonance')!;
    expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(defX, 0.5), 6);
    expect(bus.get('filter.resonance')).toBeCloseTo(fromNorm(defY, 0.5), 6);
  });

  it('restores every touched param to its pre-play value on stop', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    const res0 = bus.get('filter.resonance');
    anchor(patterns, 0, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0);
    clock.fireStop();
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
    expect(bus.get('filter.resonance')).toBe(res0);
  });

  it('restores baselines when the machine is disabled mid-play', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    anchor(patterns, 0, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    machine.setEnabled(false);
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
  });

  it('resolves per-bank assignment overrides with per-axis fallback', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    // Bank A overrides only x → fx.delay.mix; y falls back to the pad's param.
    patterns.setMotionAssign({ x: 'fx.delay.mix' });
    anchor(patterns, 0, 1, 1);
    const delay0 = bus.get('fx.delay.mix');
    const cutoff0 = bus.get('filter.cutoff');
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('fx.delay.mix')).not.toBe(delay0);
    expect(bus.get('filter.cutoff')).toBe(cutoff0);              // x went elsewhere
    expect(bus.get('filter.resonance')).toBe(bus.def('filter.resonance')!.max); // y fallback
    // Stop restores params from BOTH assignments' history.
    clock.fireStop();
    expect(bus.get('fx.delay.mix')).toBe(delay0);
  });

  it('writes nothing while the arrangement lane rests', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    machine.setEnabled(true);
    anchor(patterns, 0, 1, 1);
    arrangement.setMotionChain([-1], true); // REST bar
    const cutoff0 = bus.get('filter.cutoff');
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
  });

  it('rest gate waits for the audible bar boundary (regression: look-ahead froze the wrong value)', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    machine.setEnabled(true);
    machine.setSlide(false);
    anchor(patterns, 12, 1, 1);   // high plateau
    anchor(patterns, 15, 0, 0);   // the "come back down" anchor
    arrangement.setMotionChain([0, -1], true); // bank A, then a REST bar
    const defX = bus.def('filter.cutoff')!;
    clock.fireStart();
    for (let i = 0; i <= 15; i++) clock.fireTick(i * STEP_DUR);
    machine.frame(14.5 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 1)); // anchor-12 hold
    // The rest bar's first tick arrives scheduled ahead of its audible time;
    // the arrangement flips motionResting NOW, but step 15 hasn't sounded yet.
    clock.fireTick(16 * STEP_DUR);
    machine.frame(15.5 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0)); // anchor 15 still writes
    // From the audible boundary on, the rest holds (no further writes).
    machine.frame(16.5 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0));
  });

  it('bank switches apply at the audible bar boundary, not at schedule time', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    machine.setEnabled(true);
    machine.setSlide(false);
    anchor(patterns, 0, 1, 1);                 // bank A: high
    patterns.setMotionEditBank(1);
    anchor(patterns, 0, 0, 0);                 // bank B: low
    patterns.setMotionEditBank(0);
    arrangement.setMotionChain([0, 1], true);
    const defX = bus.def('filter.cutoff')!;
    clock.fireStart();
    for (let i = 0; i <= 15; i++) clock.fireTick(i * STEP_DUR);
    // Bank B's first tick arrives ahead of time; frames before its `when`
    // must still evaluate bank A.
    clock.fireTick(16 * STEP_DUR);
    machine.frame(15.9 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 1));
    machine.frame(16 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0));
  });

  it('reads the play bank the arrangement selects, not the edit bank', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    machine.setEnabled(true);
    // Bank B carries the anchors; the chain plays B while A stays the edit bank.
    patterns.setMotionEditBank(1);
    anchor(patterns, 0, 1, 1);
    patterns.setMotionEditBank(0);
    arrangement.setMotionChain([1], true);
    const cutoff0 = bus.get('filter.cutoff');
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0);
  });

  it('muting mid-play stops writes and restores baselines; unmuting resumes (REQ-12)', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    anchor(patterns, 0, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0);
    machine.setMuted(true);
    expect(bus.get('filter.cutoff')).toBe(cutoff0); // baseline restored
    machine.frame(STEP_DUR);                        // frames are inert while muted
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
    machine.setMuted(false);
    machine.frame(2 * STEP_DUR);                    // automation resumes
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0);
  });

  it('mute + disable never double-restores or loses the baseline', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    anchor(patterns, 0, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    machine.setMuted(true);      // restores
    machine.setEnabled(false);   // already inactive — a no-op flip
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
    // Re-enabling while still muted must NOT start writing.
    machine.setEnabled(true);
    machine.frame(STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
  });

  it('notifies step listeners with the raw step only while enabled', () => {
    const { clock, machine } = build();
    const seen: number[] = [];
    machine.onStep((s) => seen.push(s));
    clock.fireStart();
    clock.fireTick(0);
    expect(seen).toEqual([]);
    machine.setEnabled(true);
    clock.fireTick(0.125);
    clock.fireTick(0.25);
    expect(seen).toEqual([1 % SEQ_LENGTH, 2 % SEQ_LENGTH]);
  });
});
