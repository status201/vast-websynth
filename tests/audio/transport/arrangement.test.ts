import { describe, it, expect, vi } from 'vitest';
import { PatternStore, SEQ_LENGTH } from '../../../src/state/patterns';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import { TestClock } from './test-clock';

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
