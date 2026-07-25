import { describe, it, expect, vi, afterEach } from 'vitest';
import { Clock } from '../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../src/audio/transport/tick-timer';

/**
 * The Clock's look-ahead loop reads AudioContext.currentTime on each timer
 * wakeup. We inject the main-thread TimeoutTimer (the Worker timer is not
 * available under jsdom anyway) and fake both clocks: a mutable `currentTime`
 * plus Vitest fake timers, advancing the audio clock between scheduler
 * wakeups so the loop emits a run of ticks we can inspect.
 */
function collectTicks(swing: number, count = 8): Array<{ step: number; when: number }> {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 } as unknown as AudioContext;
  const clock = new Clock(ctx, { timer: new TimeoutTimer() });
  clock.setBpm(120); // one 16th = 0.125s
  clock.setSwing(swing);

  const ev: Array<{ step: number; when: number }> = [];
  clock.onTick((step, when) => ev.push({ step, when }));

  clock.start(); // emits step 0 synchronously
  for (let i = 0; i < count && ev.length < count; i++) {
    (ctx as { currentTime: number }).currentTime += 0.125;
    vi.advanceTimersByTime(25); // fire one look-ahead wakeup
  }
  clock.stop();
  return ev.slice(0, count);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Clock nudge (MIDI clock sync phase correction)', () => {
  function startedClock() {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(120); // one 16th = 0.125s
    const ev: Array<{ step: number; when: number }> = [];
    clock.onTick((step, when) => ev.push({ step, when }));
    return { ctx, clock, ev };
  }

  it('shifts only the future step grid', () => {
    const { ctx, clock, ev } = startedClock();
    clock.start(); // step 0 at 0.05
    clock.nudge(0.02);
    ctx.currentTime += 0.125;
    vi.advanceTimersByTime(25);
    expect(ev[0]!.when).toBeCloseTo(0.05, 6); // already emitted — untouched
    expect(ev[1]!.when).toBeCloseTo(0.175 + 0.02, 6); // future grid moved
    clock.stop();
  });

  it('clamps a correction to ±0.05 s', () => {
    const { ctx, clock, ev } = startedClock();
    clock.start();
    clock.nudge(0.5); // way past the clamp
    ctx.currentTime += 0.25;
    vi.advanceTimersByTime(25);
    expect(ev[1]!.when).toBeCloseTo(0.175 + 0.05, 6);
    clock.stop();
  });

  it('is a no-op while stopped', () => {
    const { clock, ev } = startedClock();
    clock.nudge(0.04);
    clock.start();
    expect(ev[0]!.when).toBeCloseTo(0.05, 6); // grid starts fresh, unshifted
    clock.stop();
  });
});

describe('Clock start(fromStep) (Song-Position seek)', () => {
  function startedClock() {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(120);
    const ev: Array<{ step: number; when: number }> = [];
    clock.onTick((step, when) => ev.push({ step, when }));
    return { ctx, clock, ev };
  }

  it('seeds the step before onStart and on the first tick', () => {
    const { clock, ev } = startedClock();
    let seenAtStart = -1;
    clock.onStart(() => { seenAtStart = clock.step; });
    clock.start(96);
    expect(seenAtStart).toBe(96);   // step visible to onStart subscribers
    expect(ev[0]!.step).toBe(96);   // first drained tick
    clock.stop();
  });

  it('masks fromStep to 16 bits', () => {
    const { clock, ev } = startedClock();
    clock.start(0x1_0002); // wraps to 2
    expect(ev[0]!.step).toBe(2); // first drained tick fires at the masked seed
    clock.stop();
  });

  it('plain start() / start(0) begins at step 0 (regression)', () => {
    const { clock: a, ev: eva } = startedClock();
    a.start();
    expect(eva[0]!.step).toBe(0);
    a.stop();
    const { clock: b, ev: evb } = startedClock();
    b.start(0);
    expect(evb[0]!.step).toBe(0);
    b.stop();
  });
});

// transport.md REQ-6/REQ-7 — moving the playhead (transport-position.md).
describe('Clock seek', () => {
  function startedClock() {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(120); // one 16th = 0.125s
    const ev: Array<{ step: number; when: number }> = [];
    clock.onTick((step, when) => ev.push({ step, when }));
    return { ctx, clock, ev };
  }

  it('moves the step while playing without disturbing the grid', () => {
    const { ctx, clock, ev } = startedClock();
    clock.start();                 // step 0 at 0.05
    ctx.currentTime += 0.125;
    vi.advanceTimersByTime(25);    // step 1 at 0.175
    expect(ev.map((e) => e.step)).toEqual([0, 1]);

    clock.seek(40);
    expect(clock.step).toBe(40);
    ctx.currentTime += 0.125;
    vi.advanceTimersByTime(25);
    // The jump changed WHICH step is next, not WHEN it sounds: the grid time is
    // exactly where it would have been without the seek.
    expect(ev[2]!.step).toBe(40);
    expect(ev[2]!.when).toBeCloseTo(0.05 + 2 * 0.125, 6);
    clock.stop();
  });

  it('fires onSeek synchronously, before any further tick', () => {
    const { clock } = startedClock();
    const seen: number[] = [];
    clock.onSeek(() => seen.push(clock.step));
    clock.start();
    clock.seek(37);
    expect(seen).toEqual([37]); // already recorded by the time seek() returns
    clock.stop();
  });

  it('cues the next start when seeked while stopped', () => {
    const { clock, ev } = startedClock();
    clock.seek(64);
    expect(clock.cue).toBe(64);
    clock.start();              // no argument: begins at the cue
    expect(ev[0]!.step).toBe(64);
    clock.stop();
  });

  it('leaves a plain start() at step 0 when nothing was seeked (REQ-5 regression)', () => {
    const { clock, ev } = startedClock();
    expect(clock.cue).toBe(0);
    clock.start();
    expect(ev[0]!.step).toBe(0);
    clock.stop();
  });

  it('keeps the cue across a stop, so Stop then Play resumes there', () => {
    const { clock, ev } = startedClock();
    clock.start();
    clock.seek(32);
    clock.stop();
    clock.start();
    expect(ev.at(-1)!.step).toBe(32);
    clock.stop();
  });

  it('start(0) still overrides a cue explicitly (the recorders rely on this)', () => {
    const { clock, ev } = startedClock();
    clock.seek(48);
    clock.start(0);
    expect(ev[0]!.step).toBe(0);
    clock.stop();
  });

  it('masks the target to 16 bits', () => {
    const { clock } = startedClock();
    clock.seek(0x1_0005);
    expect(clock.step).toBe(5);
    expect(clock.cue).toBe(5);
  });
});

describe('Clock swing', () => {
  it('emits a straight grid when swing is 0', () => {
    const ev = collectTicks(0);
    // Grid starts at currentTime + 0.05 and steps by one 16th (0.125s).
    for (const { step, when } of ev) {
      expect(when).toBeCloseTo(0.05 + step * 0.125, 6);
    }
  });

  it('delays the off-beat 16ths by swing * 0.5 * sixteenth', () => {
    const ev = collectTicks(1); // max swing
    const sixteenth = 0.125;
    for (const { step, when } of ev) {
      const grid = 0.05 + step * sixteenth;
      const off = (step & 1) === 1 ? 1 * 0.5 * sixteenth : 0; // 0.0625 on odd steps
      expect(when).toBeCloseTo(grid + off, 6);
    }
  });

  it('keeps the underlying grid spacing intact (no drift) under swing', () => {
    const ev = collectTicks(1);
    // Even steps sit on the grid; consecutive even steps stay 0.25s apart.
    const evens = ev.filter((e) => (e.step & 1) === 0);
    for (let i = 1; i < evens.length; i++) {
      expect(evens[i]!.when - evens[i - 1]!.when).toBeCloseTo(0.25, 6);
    }
  });
});
