import { describe, it, expect, vi } from 'vitest';
import { PatternStore, SEQ_LENGTH, REST } from '../../../src/state/patterns';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import { TestClock } from './test-clock';

const playBar = (clock: TestClock, bar: number): void => {
  for (let i = bar * SEQ_LENGTH; i < (bar + 1) * SEQ_LENGTH; i++) clock.fireTick(i);
};

describe('Arrangement', () => {
  it('play banks track edit banks on start when lanes are disabled', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    patterns.setSeqEditBank(2);
    patterns.setDrumEditBank(1);

    // recompute() only runs on start and bar boundaries
    clock.fireStart();
    expect(arr.seqPlayBank).toBe(2);
    expect(arr.drumPlayBank).toBe(1);
  });

  it('play banks follow chain when lanes are enabled', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setSeqChain([0, 1, 2], true);
    clock.fireStart();

    // First bar (SEQ_LENGTH ticks) → pos 0 → bank 0
    for (let i = 0; i < SEQ_LENGTH; i++) clock.fireTick(i);
    expect(arr.seqPlayBank).toBe(0);

    // Second bar → pos 1 → bank 1
    for (let i = SEQ_LENGTH; i < SEQ_LENGTH * 2; i++) clock.fireTick(i);
    expect(arr.seqPlayBank).toBe(1);

    // Third bar → pos 2 → bank 2
    for (let i = SEQ_LENGTH * 2; i < SEQ_LENGTH * 3; i++) clock.fireTick(i);
    expect(arr.seqPlayBank).toBe(2);
  });

  it('wraps around the chain', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setSeqChain([0, 1], true);
    clock.fireStart();

    // bar 0 → bank 0, bar 1 → bank 1, bar 2 → wraps to bank 0
    for (let i = 0; i < SEQ_LENGTH * 3; i++) clock.fireTick(i);
    expect(arr.seqPlayBank).toBe(0);
  });

  it('resets positions on start', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setSeqChain([3, 0], true);
    clock.fireStart();

    // first bar → bank 3 (chain[0])
    for (let i = 0; i < SEQ_LENGTH; i++) clock.fireTick(i);
    expect(arr.seqPlayBank).toBe(3);

    // second bar → bank 0 (chain[1])
    for (let i = SEQ_LENGTH; i < SEQ_LENGTH * 2; i++) clock.fireTick(i);
    expect(arr.seqPlayBank).toBe(0);

    // Fire start — resets to pos 0
    clock.fireStart();
    for (let i = 0; i < SEQ_LENGTH; i++) clock.fireTick(i);
    // first bar of new start → bank 3 (chain[0]) again
    expect(arr.seqPlayBank).toBe(3);
  });

  it('a plain start (step 0) seeks to bar 0 (v3 regression, bit-identical to v2)', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setSeqChain([0, 1, 2], true);
    clock.fireStart(); // step 0
    expect(arr.seqChainPos).toBe(0);
    playBar(clock, 0);
    expect(arr.seqPlayBank).toBe(0);
    playBar(clock, 1);
    expect(arr.seqPlayBank).toBe(1); // advances on the next boundary
  });

  it('a bar-aligned nonzero start seeks straight to the implied bar (v3)', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setSeqChain([0, 1, 2], true);
    // Start at bar 2 (like a Song-Position join). onStart runs after step is seeded.
    clock.fireStart(SEQ_LENGTH * 2);
    expect(arr.seqChainPos).toBe(2);
    playBar(clock, 2); // this bar plays slot 2, first boundary is suppressed
    expect(arr.seqPlayBank).toBe(2);
    playBar(clock, 3); // next boundary wraps 2 -> 0
    expect(arr.seqPlayBank).toBe(0);
  });

  it('a mid-bar nonzero start seeks to that bar and increments on the next boundary (v3)', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setSeqChain([0, 1, 2], true);
    clock.fireStart(SEQ_LENGTH * 1 + 4); // bar 1, offset 4 into the bar
    expect(arr.seqChainPos).toBe(1);
    // Remaining ticks of bar 1 (steps 20..31) do nothing (not on a boundary).
    for (let i = 0; i < SEQ_LENGTH - 4; i++) clock.fireTick();
    expect(arr.seqPlayBank).toBe(1);
    // Step 32 is the next boundary → increments to slot 2 (not suppressed).
    playBar(clock, 2);
    expect(arr.seqPlayBank).toBe(2);
  });

  it('notifies onChange when chain is set', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);
    const fn = vi.fn();
    arr.onChange(fn);

    arr.setSeqChain([1, 2], true);
    expect(fn).toHaveBeenCalledTimes(1);

    arr.setDrumChain([0], true);
    expect(fn).toHaveBeenCalledTimes(2);

    arr.setSamplerChain([3], true);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('notifies onChange on bar advance', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);
    const fn = vi.fn();
    arr.onChange(fn);
    arr.setSeqChain([0, 1], true);

    clock.fireStart();
    fn.mockClear();

    // Advance one bar
    for (let i = 0; i < SEQ_LENGTH; i++) clock.fireTick(i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns chain positions', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    expect(arr.seqChainPos).toBe(0);
    expect(arr.drumChainPos).toBe(0);
    expect(arr.samplerChainPos).toBe(0);

    arr.setSeqChain([1, 2, 3], true);
    clock.fireStart();
    // After first bar, pos = 0 still (first bar is reset to 0)
    for (let i = 0; i < SEQ_LENGTH; i++) clock.fireTick(i);
    expect(arr.seqChainPos).toBe(0);

    // After second bar, pos = 1
    for (let i = SEQ_LENGTH; i < SEQ_LENGTH * 2; i++) clock.fireTick(i);
    expect(arr.seqChainPos).toBe(1);
  });

  it('chains update play bank on every bar', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setDrumChain([1, 2], true);
    clock.fireStart();

    // Bar 1 → bank 1; the `setDrumEditBank` is just a fallback
    patterns.setDrumEditBank(3);
    for (let i = 0; i < SEQ_LENGTH; i++) clock.fireTick(i);
    expect(arr.drumPlayBank).toBe(1);

    // Bar 2 → bank 2
    for (let i = SEQ_LENGTH; i < SEQ_LENGTH * 2; i++) clock.fireTick(i);
    expect(arr.drumPlayBank).toBe(2);
  });

  it('disabled lane falls back to edit bank on next bar', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setDrumChain([1, 2], false);
    clock.fireStart();
    // Disabled chain: play bank tracks edit bank
    patterns.setDrumEditBank(3);
    // recompute() runs on the next bar boundary
    for (let i = 0; i < SEQ_LENGTH; i++) clock.fireTick(i);
    expect(arr.drumPlayBank).toBe(3);
  });

  it('a REST chain slot marks the lane resting for that bar only', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setSeqChain([0, REST, 1], true);
    clock.fireStart();

    // Bar 0 → bank A, not resting
    playBar(clock, 0);
    expect(arr.seqResting).toBe(false);
    expect(arr.seqPlayBank).toBe(0);

    // Bar 1 → REST → resting; play bank is a safe real index (never triggered)
    playBar(clock, 1);
    expect(arr.seqResting).toBe(true);
    expect(arr.seqPlayBank).toBe(0);

    // Bar 2 → bank B → resting clears
    playBar(clock, 2);
    expect(arr.seqResting).toBe(false);
    expect(arr.seqPlayBank).toBe(1);
  });

  it('setSeqChain preserves the REST sentinel', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);
    arr.setSeqChain([0, REST, 5], true); // 5 clamps to 3, REST survives
    expect(arr.seq.steps).toEqual([0, REST, 3]);
  });

  it('a disabled lane is never resting even with a REST step', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);

    arr.setDrumChain([REST], false);
    patterns.setDrumEditBank(2);
    clock.fireStart();
    playBar(clock, 0);
    expect(arr.drumResting).toBe(false);
    expect(arr.drumPlayBank).toBe(2); // follows edit bank
  });

  it('onChange unsubscribe works', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);
    const fn = vi.fn();
    const unsub = arr.onChange(fn);
    unsub();
    arr.setSeqChain([1], true);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('Arrangement — motion lane (4th chain lane, motion-sequencer.md REQ-6)', () => {
  it('a disabled motion lane follows the motion edit bank', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);
    patterns.setMotionEditBank(3);
    clock.fireStart();
    expect(arr.motionPlayBank).toBe(3);
    expect(arr.motionResting).toBe(false);
  });

  it('an enabled motion chain advances one slot per bar and wraps', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);
    arr.setMotionChain([0, 2], true);
    clock.fireStart();
    playBar(clock, 0);
    expect(arr.motionPlayBank).toBe(0);
    playBar(clock, 1);
    expect(arr.motionPlayBank).toBe(2);
    playBar(clock, 2);
    expect(arr.motionPlayBank).toBe(0); // wrapped
  });

  it('a REST slot sets motionResting', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arr = new Arrangement(patterns, clock);
    arr.setMotionChain([REST], true);
    clock.fireStart();
    expect(arr.motionResting).toBe(true);
  });

  describe('neighbour bars (REQ-2b, the motion curve\'s bar-line carry)', () => {
    it('resolves the bars either side of the current slot, wrapping at both ends', () => {
      const clock = new TestClock();
      const arr = new Arrangement(new PatternStore(), clock);
      arr.setMotionChain([0, 1, 2], true);
      clock.fireStart();
      playBar(clock, 0);
      expect([arr.motionPrevPlayBank, arr.motionPlayBank, arr.motionNextPlayBank])
        .toEqual([2, 0, 1]); // wraps back to the chain's last slot
      playBar(clock, 1);
      expect([arr.motionPrevPlayBank, arr.motionPlayBank, arr.motionNextPlayBank])
        .toEqual([0, 1, 2]);
      playBar(clock, 2);
      expect([arr.motionPrevPlayBank, arr.motionPlayBank, arr.motionNextPlayBank])
        .toEqual([1, 2, 0]); // wraps forward to the first slot
    });

    it('flags a resting neighbour', () => {
      const clock = new TestClock();
      const arr = new Arrangement(new PatternStore(), clock);
      arr.setMotionChain([0, REST], true);
      clock.fireStart();
      playBar(clock, 0);
      expect(arr.motionNextResting).toBe(true);
      expect(arr.motionPrevResting).toBe(true); // a 2-slot chain: same bar both ways
      playBar(clock, 1);
      expect(arr.motionResting).toBe(true);
      expect(arr.motionNextResting).toBe(false);
    });

    it('a disabled lane reports the edit bank on both sides (it loops on itself)', () => {
      const clock = new TestClock();
      const patterns = new PatternStore();
      const arr = new Arrangement(patterns, clock);
      patterns.setMotionEditBank(2);
      clock.fireStart();
      expect([arr.motionPrevPlayBank, arr.motionNextPlayBank]).toEqual([2, 2]);
      expect([arr.motionPrevResting, arr.motionNextResting]).toEqual([false, false]);
    });
  });
});
