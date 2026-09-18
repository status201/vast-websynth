import { describe, it, expect, vi } from 'vitest';
import {
  TransportLoop, effectiveLoopRange, routeLoopStep,
} from '../../../src/audio/transport/transport-loop';
import { MAX_CHAIN_STEPS } from '../../../src/state/limits';

/** transport-loop.md — the model and the pure wrap rule, no clock involved. */
describe('TransportLoop (model)', () => {
  // REQ-with-loop-on-a-click-picks-a-bar — the first pick is an anchor, the second closes the range.
  it('two picks make a range, in either order; one bar twice is a one-bar loop', () => {
    const loop = new TransportLoop();
    loop.setEnabled(true);
    loop.pick(3);
    expect(loop.anchor).toBe(3);
    expect(loop.range).toBeNull();
    expect(loop.engaged).toBe(false);
    loop.pick(2);
    expect(loop.range).toEqual({ start: 2, end: 3 });
    expect(loop.anchor).toBeNull();
    expect(loop.engaged).toBe(true);

    loop.pick(1);
    loop.pick(1);
    expect(loop.range).toEqual({ start: 1, end: 1 });
  });

  // REQ-with-loop-on-a-click-picks-a-bar — re-picking never interrupts the loop that is playing.
  it('keeps the old range in force until the second pick lands', () => {
    const loop = new TransportLoop();
    loop.setEnabled(true);
    loop.pick(1);
    loop.pick(2);
    loop.pick(4); // a first pick of a new range
    expect(loop.range).toEqual({ start: 1, end: 2 });
    expect(loop.engaged).toBe(true);
    expect(loop.anchor).toBe(4);
  });

  it('ignores picks while Loop is off', () => {
    const loop = new TransportLoop();
    loop.pick(2);
    loop.pick(3);
    expect(loop.anchor).toBeNull();
    expect(loop.range).toBeNull();
  });

  // REQ-turning-loop-off-keeps-the-range — off keeps the range and drops the half-made pick; on reuses it.
  it('off remembers the range, drops the anchor; on re-engages at once', () => {
    const loop = new TransportLoop();
    loop.setEnabled(true);
    loop.pick(2);
    loop.pick(3);
    loop.pick(0); // anchor pending
    loop.setEnabled(false);
    expect(loop.engaged).toBe(false);
    expect(loop.anchor).toBeNull();
    expect(loop.range).toEqual({ start: 2, end: 3 });
    loop.toggle();
    expect(loop.engaged).toBe(true);
    expect(loop.range).toEqual({ start: 2, end: 3 });
  });

  // REQ-loading-a-song-clears-the-loop — a loaded song's bars are not this song's.
  it('clear() forgets everything', () => {
    const loop = new TransportLoop();
    loop.setEnabled(true);
    loop.pick(2);
    loop.pick(3);
    loop.clear();
    expect(loop.enabled).toBe(false);
    expect(loop.range).toBeNull();
    expect(loop.anchor).toBeNull();
  });

  // REQ-the-loop-range-is-limited-to-the-song — bounded at ingress, like every position.
  it('refuses non-finite picks and clamps the rest', () => {
    const loop = new TransportLoop();
    loop.setEnabled(true);
    loop.pick(Number.NaN);
    expect(loop.anchor).toBeNull();
    loop.pick(-4);
    loop.pick(1e9);
    expect(loop.range).toEqual({ start: 0, end: MAX_CHAIN_STEPS - 1 });
  });

  it('notifies only on a real change', () => {
    const loop = new TransportLoop();
    const fn = vi.fn();
    loop.onChange(fn);
    loop.setEnabled(false); // already off
    loop.clear();           // already clear
    loop.pick(1);           // off: ignored
    expect(fn).not.toHaveBeenCalled();
    loop.setEnabled(true);
    loop.pick(1);
    loop.pick(2);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('effectiveLoopRange (REQ-the-loop-range-is-limited-to-the-song)', () => {
  it('clamps to the song without editing the stored range', () => {
    const stored = { start: 2, end: 4 };
    expect(effectiveLoopRange(stored, 6)).toEqual({ start: 2, end: 4 });
    expect(effectiveLoopRange(stored, 4)).toEqual({ start: 2, end: 3 });
    expect(stored).toEqual({ start: 2, end: 4 });
  });

  it('treats no enabled chain as one bar', () => {
    expect(effectiveLoopRange({ start: 2, end: 4 }, 0)).toEqual({ start: 0, end: 0 });
    expect(effectiveLoopRange(null, 4)).toBeNull();
  });
});

describe('routeLoopStep (REQ-the-loop-wraps-only-on-a-bar-line)', () => {
  const r = { start: 1, end: 2 }; // bars 2–3 in 4/4: steps 16..47

  it('keeps every step that is not on a bar line', () => {
    for (const n of [1, 5, 15, 17, 47, 53, 63]) expect(routeLoopStep(n, r, 16)).toBe(n);
  });

  it('keeps a bar line inside the range', () => {
    expect(routeLoopStep(16, r, 16)).toBe(16);
    expect(routeLoopStep(32, r, 16)).toBe(32);
  });

  it('goes back to the start at the end of the range', () => {
    expect(routeLoopStep(48, r, 16)).toBe(16);
  });

  // Engaged while playing elsewhere: finish the bar, then go in — never mid-bar.
  it('enters from outside at the next bar line, before or after the range', () => {
    expect(routeLoopStep(0, r, 16)).toBe(16);
    expect(routeLoopStep(64, r, 16)).toBe(16);
    expect(routeLoopStep(144, r, 16)).toBe(16);
  });

  // REQ-loop-bars-are-the-songs-bars — a bar is barTicks, not 16.
  it('measures the song bar: 3/4 loops bars 2–3 over steps 12..35', () => {
    expect(routeLoopStep(12, r, 12)).toBe(12);
    expect(routeLoopStep(24, r, 12)).toBe(24);
    expect(routeLoopStep(36, r, 12)).toBe(12);
    expect(routeLoopStep(16, r, 12)).toBe(16); // not a 3/4 bar line
  });

  it('is the identity with no range', () => {
    expect(routeLoopStep(48, null, 16)).toBe(48);
  });
});
