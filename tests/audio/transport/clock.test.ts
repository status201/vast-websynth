// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Clock } from '../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../src/audio/transport/tick-timer';
import { MAX_STEP } from '../../../src/state/limits';

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

  it('keeps fromStep past 16 bits instead of folding it (REQ-song-position-pointer-jumps-the-slave)', () => {
    const { clock, ev } = startedClock();
    // Masked to 2 before v7. A fold is only phase-safe for bar lengths dividing
    // 65536, so meter.md REQ-the-step-counter-must-not-wrap replaced it with an ingress clamp.
    clock.start(0x1_0002);
    expect(ev[0]!.step).toBe(0x1_0002);
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

// transport.md REQ-seek-moves-a-running-clock/REQ-the-cue-is-where-start-begins — moving the playhead (transport-position.md).
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

  it('leaves a plain start() at step 0 when nothing was seeked (REQ-phase-correction-uses-nudge regression)', () => {
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

  it('keeps the target past 16 bits instead of folding it (REQ-song-position-pointer-jumps-the-slave)', () => {
    const { clock } = startedClock();
    clock.seek(0x1_0005); // masked to 5 before v7
    expect(clock.step).toBe(0x1_0005);
    expect(clock.cue).toBe(0x1_0005);
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

// transport.md REQ-a-subscriber-may-not-wedge-the-transport / ADR-015. The bug this pins: a throwing listener escaped
// the tick loop BEFORE `nextStepTime += sixteenth` and `_step++`, leaving
// _playing true and the grid unmoved — so the timer re-entered the same step
// every 25 ms forever and every lane registered after the thrower went silent.
// An imported song with an out-of-range note reached it via an AudioParam throw.
describe('Clock listener isolation (untrusted-input)', () => {
  function startedClock() {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(120); // one 16th = 0.125s
    return { ctx, clock };
  }

  it('keeps the transport running when a listener throws every tick', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, clock } = startedClock();
    const seenByGood: number[] = [];
    clock.onTick(() => { throw new Error('an AudioParam refused a value'); });
    clock.onTick((step) => seenByGood.push(step));

    clock.start(); // emits step 0 synchronously
    for (let i = 0; i < 4; i++) {
      ctx.currentTime += 0.125;
      vi.advanceTimersByTime(25);
    }
    clock.stop();

    // The step counter advanced rather than re-entering step 0 forever...
    expect(clock.step).toBeGreaterThan(1);
    // ...and the listener registered AFTER the thrower still ran, every tick.
    expect(seenByGood).toEqual([0, 1, 2, 3, 4]);
    err.mockRestore();
  });

  it('reports a faulting listener once, not once per tick', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, clock } = startedClock();
    clock.onTick(() => { throw new Error('boom'); });

    clock.start();
    for (let i = 0; i < 5; i++) {
      ctx.currentTime += 0.125;
      vi.advanceTimersByTime(25);
    }
    clock.stop();

    // At ~40 Hz, once-per-tick would bury the first (most useful) stack.
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  // (v9) The same rule, on the three fan-outs that were still bare. `start()` is
  // the one that bit: it fired its listeners with `_playing` already true and
  // BEFORE `tick()` / `timer.start(...)`, so a throw left a clock that believed
  // it was playing with no timer armed — and `start()` early-returns on
  // `_playing`, so every retry did nothing. Only `stop()` could unstick it.
  it('keeps the transport startable when a start listener throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, clock } = startedClock();
    const seenByGood: number[] = [];
    clock.onStart(() => { throw new Error('a lane refused to arm'); });
    let goodStarts = 0;
    clock.onStart(() => { goodStarts++; });
    clock.onTick((step) => seenByGood.push(step));

    clock.start();
    // The listener registered after the thrower still ran...
    expect(goodStarts).toBe(1);
    // ...the first tick was still emitted synchronously...
    expect(seenByGood).toEqual([0]);
    // ...and the timer was still armed, so the grid keeps moving.
    for (let i = 0; i < 3; i++) {
      ctx.currentTime += 0.125;
      vi.advanceTimersByTime(25);
    }
    expect(clock.step).toBeGreaterThan(1);
    expect(clock.playing).toBe(true);
    clock.stop();
    err.mockRestore();
  });

  it('does not strand the later stop listeners when an earlier one throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { clock } = startedClock();
    clock.onStop(() => { throw new Error('a lane refused to release'); });
    let released = 0;
    // Registration order is load-bearing: the sequencer's note release and the
    // motion machine's baseline restore are downstream of earlier subscribers.
    clock.onStop(() => { released++; });

    clock.start();
    clock.stop();

    expect(released).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('isolates a throwing seek listener on a direct scrub, not just a routed wrap', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { clock } = startedClock();
    clock.onSeek(() => { throw new Error('a lane refused to re-base'); });
    let reseated = 0;
    clock.onSeek(() => { reseated++; });

    clock.seek(12); // the user scrubbing, NOT route()

    expect(reseated).toBe(1);
    expect(clock.step).toBe(12);
    err.mockRestore();
  });

  it('ignores a non-finite tempo or swing instead of stalling', () => {
    // Math.max(20, Math.min(400, NaN)) is NaN, which makes `sixteenth` NaN and
    // stops the scheduler. A paired WiFi peer can send {t:'tempo', bpm}.
    const { clock } = startedClock();
    clock.setBpm(NaN);
    expect(clock.bpm).toBe(120);
    clock.setBpm(Number.POSITIVE_INFINITY);
    expect(clock.bpm).toBe(120);
    clock.setSwing(NaN); // no throw, and swing stays usable
    clock.setBpm(140);
    expect(clock.bpm).toBe(140);
  });
});

// transport.md REQ-the-transport-catch-up-is-bounded / audio-lifecycle.md. The bug this pins: Chrome on Android
// freezes a hidden page's renderer when the screen turns off (a Pixel 8a does; a
// Samsung tablet does not), so the worker wakeups stop while ctx.currentTime keeps
// running. The unbounded drain loop then emitted every missed 16th on the next
// wakeup — hundreds of notes with a `when` in the past, clamped to now downstream
// and fired at once (crackle), with the step counter racing (runaway clock).
describe('Clock dropout recovery (stalled wakeup source)', () => {
  function startedClock() {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(120); // one 16th = 0.125s
    const ev: Array<{ step: number; when: number }> = [];
    clock.onTick((step, when) => ev.push({ step, when }));
    return { ctx, clock, ev };
  }

  it('drops the gap instead of bursting it, and resumes from the same step', () => {
    const { ctx, clock, ev } = startedClock();
    clock.start();                 // step 0 at 0.05
    ctx.currentTime += 0.125;
    vi.advanceTimersByTime(25);    // step 1, healthy
    expect(ev.map((e) => e.step)).toEqual([0, 1]);
    expect(clock.dropouts).toBe(0);

    ctx.currentTime += 60;         // the renderer was frozen for a minute
    vi.advanceTimersByTime(25);
    expect(ev).toHaveLength(2);    // nothing at all was emitted for the gap
    expect(clock.dropouts).toBe(1);

    ctx.currentTime += 0.025;      // the next wakeup, arriving on time again
    vi.advanceTimersByTime(25);
    // Playback continues from the step it was on — a dropout is a pause, not a
    // seek — and the tick it emits is in the FUTURE, not clamped from the past.
    expect(ev[2]!.step).toBe(2);
    expect(ev[2]!.when).toBeGreaterThan(ctx.currentTime);
    expect(clock.dropouts).toBe(1);
    clock.stop();
  });

  it('stays silent for as long as the source stays stalled', () => {
    const { ctx, clock, ev } = startedClock();
    clock.start();
    ev.length = 0;
    for (let i = 0; i < 3; i++) {  // three throttled wakeups, a minute apart
      ctx.currentTime += 60;
      vi.advanceTimersByTime(25);
    }
    expect(ev).toEqual([]);
    expect(clock.dropouts).toBe(3);
    clock.stop();
  });

  it('still absorbs ordinary jitter — two owed steps are not a dropout', () => {
    const { ctx, clock, ev } = startedClock();
    clock.start();                 // step 0 at 0.05
    ev.length = 0;
    ctx.currentTime += 0.24;       // late, but inside DROPOUT_S of the grid
    vi.advanceTimersByTime(25);
    expect(ev.map((e) => e.step)).toEqual([1, 2]);
    expect(clock.dropouts).toBe(0);
    clock.stop();
  });

  it('caps one wakeup even when listeners outrun the grid', () => {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(400); // the fastest 16th the clock allows: 0.0375s
    const steps: number[] = [];
    // Each listener call burns more wall-clock than the step it just scheduled,
    // so the drain condition (which re-reads currentTime) never goes false.
    clock.onTick((step) => { steps.push(step); ctx.currentTime += 0.05; });

    clock.start(); // drains synchronously — must terminate, and be bounded
    expect(steps.length).toBeLessThanOrEqual(16);
    expect(steps.length).toBeGreaterThan(0);
    clock.stop();
  });
});

describe('Clock step counter — no wrap, bounded at ingress (transport.md REQ-the-step-counter-is-bounded-at-ingress)', () => {
  function startedClock(bpm = 120) {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(bpm);
    const ev: Array<{ step: number; when: number }> = [];
    clock.onTick((step, when) => ev.push({ step, when }));
    return { ctx, clock, ev };
  }

  it('passes 65536 without folding — the old mask jumped lane phase there', () => {
    const { ctx, clock, ev } = startedClock();
    clock.start(65534);
    for (let i = 0; i < 4; i++) {
      ctx.currentTime += 0.125;
      vi.advanceTimersByTime(25);
    }
    expect(ev.map((e) => e.step).slice(0, 4)).toEqual([65534, 65535, 65536, 65537]);
    expect(clock.step).toBeGreaterThan(65536);
    clock.stop();
  });

  it('clamps a seek instead of masking it', () => {
    const { clock } = startedClock();
    clock.seek(1e12);
    expect(clock.step).toBe(MAX_STEP);
    clock.seek(-5);
    expect(clock.step).toBe(0);
    clock.seek(37.9);
    expect(clock.step).toBe(37);
  });

  it('leaves the position at 0 for a non-finite seek', () => {
    const { clock } = startedClock();
    clock.seek(NaN);
    expect(clock.step).toBe(0);
    clock.seek(Infinity);
    expect(clock.step).toBe(0);
  });

  it('clamps start(fromStep) the same way', () => {
    const { clock } = startedClock();
    clock.start(1e12);
    expect(clock.step).toBeGreaterThanOrEqual(MAX_STEP);
    clock.stop();
  });
});

describe('Clock.swingOffset (transport.md REQ-swing-offset-is-public)', () => {
  it('reports exactly the delay the emitted tick carried', () => {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(120);
    clock.setSwing(0.5);
    const ev: Array<{ step: number; when: number }> = [];
    clock.onTick((step, when) => ev.push({ step, when }));
    clock.start();
    for (let i = 0; i < 4; i++) {
      ctx.currentTime += 0.125;
      vi.advanceTimersByTime(25);
    }
    clock.stop();
    // Unswung grid time for step n is 0.05 + n * 0.125; the difference from the
    // emitted `when` must be what swingOffset says it is.
    for (const e of ev.slice(0, 4)) {
      expect(e.when - (0.05 + e.step * 0.125)).toBeCloseTo(clock.swingOffset(e.step), 9);
    }
  });

  it('is 0 on even steps at any swing amount, and 0 everywhere when straight', () => {
    const ctx = { currentTime: 0 } as unknown as AudioContext;
    const clock = new Clock(ctx, { timer: new TimeoutTimer() });
    clock.setBpm(120);
    clock.setSwing(1);
    expect(clock.swingOffset(0)).toBe(0);
    expect(clock.swingOffset(2)).toBe(0);
    expect(clock.swingOffset(1)).toBeCloseTo(0.0625, 9); // half a 16th at 120 BPM
    clock.setSwing(0);
    expect(clock.swingOffset(1)).toBe(0);
  });
});

/** A started-able clock on the injected timer, with a hand-driven audio clock. */
function drivenClock() {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 } as { currentTime: number };
  const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
  clock.setBpm(120); // one 16th = 0.125 s
  const ev: Array<{ step: number; when: number }> = [];
  clock.onTick((step, when) => ev.push({ step, when }));
  /** One 16th of audio time, then one look-ahead wakeup. */
  const wake = (n = 1): void => {
    for (let i = 0; i < n; i++) { ctx.currentTime += 0.125; vi.advanceTimersByTime(25); }
  };
  return { ctx, clock, ev, wake };
}

// transport.md REQ-pause-resumes-where-it-stopped (v8) — Pause is Stop that remembers where it was.
describe('Clock pause (v8)', () => {
  it('resumes from the first step not yet scheduled', () => {
    const { clock, ev, wake } = drivenClock();
    const stops = vi.fn();
    clock.onStop(stops);
    let cueSeenByStop = -1;
    clock.onStop(() => { cueSeenByStop = clock.cue; });

    clock.start();
    wake(4);
    const next = clock.step; // the step the drain would emit next
    expect(ev.at(-1)!.step).toBe(next - 1);

    clock.pause();
    expect(clock.playing).toBe(false);
    expect(stops).toHaveBeenCalledTimes(1);
    expect(clock.paused).toBe(true);
    expect(clock.cue).toBe(next);
    expect(cueSeenByStop).toBe(next); // stop listeners already read the resume point

    ev.length = 0;
    clock.start();
    expect(ev[0]!.step).toBe(next); // nothing repeated, nothing skipped
    expect(clock.paused).toBe(false);
    clock.stop();
  });

  it('is a no-op while stopped', () => {
    const { clock } = drivenClock();
    const stops = vi.fn();
    clock.onStop(stops);
    clock.pause();
    expect(stops).not.toHaveBeenCalled();
    expect(clock.paused).toBe(false);
  });

  it('a resumed run still Stops back to the cue, not the pause', () => {
    const { clock, ev, wake } = drivenClock();
    clock.start();
    wake(4);
    clock.pause();
    clock.start(); // resumes mid-way
    expect(clock.cue).toBe(0); // while playing, the cue is where Stop returns
    wake(2);
    clock.stop();
    ev.length = 0;
    clock.start();
    expect(ev[0]!.step).toBe(0);
    clock.stop();
  });

  it('a seek, or a stop while already paused, cancels the resume', () => {
    const { clock, ev, wake } = drivenClock();
    clock.start();
    wake(4);
    clock.pause();
    clock.seek(12);
    expect(clock.paused).toBe(false);
    ev.length = 0;
    clock.start();
    expect(ev[0]!.step).toBe(12);

    wake(3);
    clock.pause();
    expect(clock.cue).not.toBe(12);
    clock.stop(); // Esc / Panic after Pause: back to the cue
    expect(clock.paused).toBe(false);
    expect(clock.cue).toBe(12);
  });
});

// transport.md REQ-a-step-router-can-redirect-the-next-step (v8) — the loop's jump, applied inside the drain.
describe('Clock step router (v8)', () => {
  it('a routed step is a jump on the same grid, with onSeek and no cue move', () => {
    const { clock, ev, wake } = drivenClock();
    const seeks = vi.fn();
    clock.onSeek(seeks);
    clock.setStepRouter((next) => (next === 8 ? 2 : next));
    clock.start();
    wake(12);
    clock.stop();

    const i7 = ev.findIndex((e) => e.step === 7);
    expect(i7).toBeGreaterThanOrEqual(0);
    const after = ev[i7 + 1]!;
    expect(after.step).toBe(2); // 8 was never emitted
    expect(after.when - ev[i7]!.when).toBeCloseTo(0.125, 9); // same grid, no retrigger
    expect(ev.some((e) => e.step === 8)).toBe(false);
    expect(seeks).toHaveBeenCalled();
    expect(clock.cue).toBe(0);
  });

  it('an identity router changes nothing and fires no seek', () => {
    const { clock, ev, wake } = drivenClock();
    const seeks = vi.fn();
    clock.onSeek(seeks);
    clock.setStepRouter((next) => next);
    clock.start();
    wake(6);
    clock.stop();
    expect(ev.map((e) => e.step)).toEqual([...ev.keys()]);
    expect(seeks).not.toHaveBeenCalled();
  });

  it('a throwing router or seek listener cannot wedge the drain', () => {
    const { clock, ev, wake } = drivenClock();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    clock.setStepRouter(() => { throw new Error('router'); });
    clock.start();
    wake(3);
    expect(ev.map((e) => e.step)).toEqual([...ev.keys()]); // advanced as if unrouted
    expect(err).toHaveBeenCalledTimes(1); // reported once, not per tick

    const later = vi.fn();
    clock.onSeek(() => { throw new Error('seek listener'); });
    clock.onSeek(later);
    const at = clock.step;
    clock.setStepRouter((next) => (next === at + 1 ? 0 : next));
    wake(3);
    expect(later).toHaveBeenCalled(); // the listener after the thrower still ran
    expect(clock.playing).toBe(true);
    expect(ev.some((e) => e.step === 0 && e.when > 0.2)).toBe(true); // the jump landed
    clock.stop();
    err.mockRestore();
  });
});

// transport.md v10 — the two primitives a sync slave joins with
// (midi-clock-sync.md REQ-a-join-is-timed-by-its-first-pulse / REQ-a-following-slave-jumps-in-place).
describe('Clock first-step time and scheduled jumps (v10)', () => {
  function rig() {
    vi.useFakeTimers();
    const ctx = { currentTime: 0 } as { currentTime: number };
    const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
    clock.setBpm(120); // one 16th = 0.125 s
    const ev: Array<{ step: number; when: number }> = [];
    clock.onTick((step, when) => ev.push({ step, when }));
    const wake = (n: number): void => {
      for (let i = 0; i < n; i++) { ctx.currentTime += 0.025; vi.advanceTimersByTime(25); }
    };
    return { ctx, clock, ev, wake };
  }

  it('start can put its first step at a given time (REQ-a-start-can-name-its-first-step-time)', () => {
    const a = rig();
    a.ctx.currentTime = 1.0;
    a.clock.start(4, 1.3);
    a.wake(10);
    expect(a.ev[0]).toEqual({ step: 4, when: expect.closeTo(1.3, 9) as unknown as number });
    a.clock.stop();

    const b = rig();
    b.ctx.currentTime = 1.0;
    b.clock.start(4); // the default lead is unchanged
    expect(b.ev[0]!.when).toBeCloseTo(1.05, 9);
    b.clock.stop();

    const c = rig();
    c.ctx.currentTime = 1.0;
    c.clock.start(4, 0.2); // a time in the past sounds now, never earlier
    expect(c.ev[0]!.when).toBeCloseTo(1.0, 9);
    c.clock.stop();
  });

  it('a scheduled jump lands on the step nearest its time (REQ-a-jump-can-be-scheduled)', () => {
    const { clock, ev, wake } = rig();
    clock.start(0); // steps at 0.05, 0.175, 0.3, …
    const seeks = vi.fn();
    clock.onSeek(seeks);
    const target = 0.05 + 6 * 0.125; // step 6's grid time, well past the look-ahead
    const nextBefore = clock.nextStepAt;
    clock.seekAt(32, target);
    expect(clock.nextStepAt).toBe(nextBefore); // held, not applied yet
    wake(40);
    const landed = ev.find((e) => Math.abs(e.when - target) < 1e-9);
    expect(landed?.step).toBe(32);
    // The steps before it kept counting, the grid was not re-seeded, and the
    // cue did not move: a jump, not a seek or a restart.
    expect(ev.filter((e) => e.when < target).map((e) => e.step)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ev.find((e) => e.step === 33)!.when).toBeCloseTo(target + 0.125, 9);
    expect(seeks).toHaveBeenCalledTimes(1);
    expect(clock.cue).toBe(0);
    clock.stop();
  });

  it('a scheduled jump the look-ahead already passed is caught up (REQ-a-jump-can-be-scheduled, edge)', () => {
    const { ctx, clock, ev } = rig();
    clock.start(0);
    expect(ev.map((e) => e.step)).toEqual([0]);
    // Let the look-ahead emit the steps at 0.175 and 0.3, then a join says
    // step 32 was due at 0.175.
    ctx.currentTime = 0.2; vi.advanceTimersByTime(25);
    const emitted = ev.length;
    clock.seekAt(32, 0.175);
    ctx.currentTime = 0.4; vi.advanceTimersByTime(25);
    // Steps at 0.175 (and any later) already went out; the next emitted one is
    // where the new position has got to by then.
    const next = ev[emitted]!;
    const k = Math.round((next.when - 0.175) / 0.125);
    expect(next.step).toBe(32 + k);
    clock.stop();
  });

  it('stop, start and seek drop a held jump', () => {
    const { clock, ev, wake } = rig();
    clock.start(0);
    clock.seekAt(32, 0.05 + 6 * 0.125);
    clock.seek(10); // a chosen position outranks a scheduled one
    wake(40);
    expect(ev.some((e) => e.step === 32)).toBe(false);
    clock.stop();
  });
});
