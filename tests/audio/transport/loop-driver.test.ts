// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Clock } from '../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../src/audio/transport/tick-timer';
import { TransportLoop } from '../../../src/audio/transport/transport-loop';
import { LoopDriver } from '../../../src/audio/transport/loop-driver';

/**
 * transport-loop.md — the driver against a REAL `Clock` on the injected
 * `TimeoutTimer`, with a hand-driven audio clock (the clock.test.ts setup). The
 * point is the jump as the clock actually emits it: which steps, on which grid.
 */
function rig(over: { songBars?: number; canSeek?: boolean } = {}) {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 } as { currentTime: number };
  const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
  clock.setBpm(120); // one 16th = 0.125 s
  const ev: Array<{ step: number; when: number }> = [];
  clock.onTick((step, when) => ev.push({ step, when }));
  const loop = new TransportLoop();
  const state = { songBars: over.songBars ?? 4, canSeek: over.canSeek ?? true };
  const seekTo = vi.fn((step: number) => {
    if (!state.canSeek) return false;
    clock.seek(step);
    return true;
  });
  const setStepRouter = vi.spyOn(clock, 'setStepRouter');
  const driver = new LoopDriver({
    clock,
    loop,
    songBars: () => state.songBars,
    canSeek: () => state.canSeek,
    seekTo,
  });
  const wake = (n = 1): void => {
    for (let i = 0; i < n; i++) { ctx.currentTime += 0.125; vi.advanceTimersByTime(25); }
  };
  /** Loop on with bars [a, b] picked. */
  const engage = (a: number, b: number): void => {
    loop.setEnabled(true);
    loop.pick(a);
    loop.pick(b);
  };
  return { clock, ev, loop, driver, state, seekTo, setStepRouter, wake, engage };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LoopDriver', () => {
  // REQ-2/REQ-3 — the loop in action, as the clock emits it.
  it('two picks loop the bars between them, on the same tempo grid', () => {
    const { clock, ev, wake, engage } = rig();
    clock.seek(16); // start inside bars 2–3
    engage(1, 2);
    clock.start();
    wake(40);
    clock.stop();

    const i47 = ev.findIndex((e) => e.step === 47);
    expect(i47).toBeGreaterThanOrEqual(0);
    expect(ev[i47 + 1]!.step).toBe(16);
    expect(ev[i47 + 1]!.when - ev[i47]!.when).toBeCloseTo(0.125, 9);
    expect(ev.every((e) => e.step >= 16 && e.step < 48)).toBe(true);
  });

  // REQ-3 — outside the range, it finishes the bar and only then goes in.
  it('engaged while playing outside the range, it enters at the next bar line', () => {
    const { clock, ev, wake, engage } = rig();
    clock.start();
    wake(4); // playing at bar 1
    engage(1, 2);
    wake(16);
    clock.stop();

    const steps = ev.map((e) => e.step);
    const i15 = steps.indexOf(15);
    expect(steps.slice(0, i15 + 1)).toEqual([...Array(16).keys()]); // bar 1 played out
    expect(steps[i15 + 1]).toBe(16); // bar 2 is the loop's own start: no jump needed
  });

  it('from past the range, it plays to the bar line and then jumps back', () => {
    const { clock, ev, wake, engage } = rig({ songBars: 6 });
    engage(1, 2);
    clock.seek(53); // after picking: REQ-4 moved the cue, the user moves it again
    clock.start();
    wake(14);
    clock.stop();
    const steps = ev.map((e) => e.step);
    expect(steps.slice(0, 11)).toEqual([53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63]);
    expect(steps[11]).toBe(16);
  });

  // REQ-3 — the cue is the user's.
  it('a wrap does not move the cue', () => {
    const { clock, wake, engage } = rig();
    engage(0, 0); // one-bar loop at bar 1; the cue (0) is already inside it
    clock.start();
    wake(40); // wraps twice
    expect(clock.step).toBeLessThan(16); // it really did wrap
    expect(clock.cue).toBe(0);
    clock.stop();
    expect(clock.cue).toBe(0);
  });

  // REQ-4 — Play should start inside the loop.
  it('engaging while stopped cues the loop start, unless the cue is already inside', () => {
    const { clock, seekTo, engage, loop } = rig();
    engage(2, 3);
    expect(seekTo).toHaveBeenCalledWith(32);
    expect(clock.cue).toBe(32);

    seekTo.mockClear();
    loop.setEnabled(false);
    clock.seek(40); // inside bars 3–4
    loop.setEnabled(true);
    expect(seekTo).not.toHaveBeenCalled();
    expect(clock.cue).toBe(40);
  });

  it('a first pick alone does not move the cue', () => {
    const { clock, seekTo, loop } = rig();
    loop.setEnabled(true);
    loop.pick(3);
    expect(seekTo).not.toHaveBeenCalled();
    expect(clock.cue).toBe(0);
  });

  // REQ-6 — an export or a slaved clock plays through an engaged loop.
  it('a refused loop never jumps, and cannot cue', () => {
    const { clock, ev, wake, engage, seekTo, state } = rig();
    state.canSeek = false;
    engage(1, 1);
    expect(seekTo).toHaveBeenCalled(); // asked, and refused
    expect(clock.cue).toBe(0);
    clock.start();
    wake(40);
    clock.stop();
    expect(ev.map((e) => e.step)).toEqual([...ev.keys()]); // straight through
  });

  // REQ-7 — a shortened song clamps the loop it plays.
  it('wraps at the clamped range when the song is shorter than the pick', () => {
    const { clock, ev, wake, engage, state } = rig({ songBars: 6 });
    clock.seek(32);
    engage(2, 5);
    state.songBars = 3; // bars 3–6 now clamp to bar 3 alone
    clock.start();
    wake(20);
    clock.stop();
    const steps = ev.map((e) => e.step);
    expect(steps).toContain(47);
    expect(steps[steps.indexOf(47) + 1]).toBe(32);
  });

  // REQ-11 — the bar is pushed from Engine.applyMeter.
  it('measures bars with the pushed barTicks', () => {
    const { clock, ev, wake, engage, driver } = rig();
    driver.setBarTicks(12);
    clock.seek(12);
    engage(1, 1); // 3/4 bar 2 = steps 12..23
    clock.start();
    wake(16);
    clock.stop();
    const steps = ev.map((e) => e.step);
    expect(steps).toContain(23);
    expect(steps[steps.indexOf(23) + 1]).toBe(12);
  });

  // REQ-14 — no router unless engaged.
  it('installs the router only while engaged', () => {
    const { loop, setStepRouter } = rig();
    const last = (): unknown => setStepRouter.mock.calls.at(-1)?.[0];
    loop.setEnabled(true);
    expect(last()).toBeNull(); // on, but nothing to loop
    loop.pick(1);
    expect(last()).toBeNull();
    loop.pick(2);
    expect(typeof last()).toBe('function');
    loop.setEnabled(false);
    expect(last()).toBeNull();
  });
});
