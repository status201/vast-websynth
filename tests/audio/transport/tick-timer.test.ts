import { describe, it, expect, vi, afterEach } from 'vitest';
import { Clock } from '../../../src/audio/transport/clock';
import { TimeoutTimer, WorkerTimer, type TickTimer } from '../../../src/audio/transport/tick-timer';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A hand-cranked TickTimer: `fire()` simulates one wakeup. */
class ManualTimer implements TickTimer {
  cb: (() => void) | null = null;
  intervalMs = 0;
  startCalls = 0;
  stopCalls = 0;
  start(cb: () => void, intervalMs: number): void {
    this.cb = cb;
    this.intervalMs = intervalMs;
    this.startCalls++;
  }
  stop(): void {
    this.stopCalls++;
  }
  fire(): void {
    this.cb?.();
  }
}

describe('Clock + TickTimer protocol', () => {
  it('starts the timer on start() and stops it on stop()', () => {
    const ctx = { currentTime: 0 } as unknown as AudioContext;
    const timer = new ManualTimer();
    const clock = new Clock(ctx, { timer });

    clock.start();
    expect(timer.startCalls).toBe(1);
    expect(timer.intervalMs).toBe(25);

    clock.stop();
    expect(timer.stopCalls).toBe(1);
  });

  it('emits ticks on wakeups as audio time advances', () => {
    const ctx = { currentTime: 0 };
    const timer = new ManualTimer();
    const clock = new Clock(ctx as unknown as AudioContext, { timer });
    const steps: number[] = [];
    clock.onTick((step) => steps.push(step));

    clock.start(); // schedules the first horizon synchronously
    expect(steps).toEqual([0]);

    ctx.currentTime += 0.125; // one 16th at 120 BPM
    timer.fire();
    expect(steps).toEqual([0, 1]);
    clock.stop();
  });

  it('emits nothing on a wakeup that lands after stop() (in-flight message)', () => {
    const ctx = { currentTime: 0 };
    const timer = new ManualTimer();
    const clock = new Clock(ctx as unknown as AudioContext, { timer });
    const steps: number[] = [];
    clock.onTick((step) => steps.push(step));

    clock.start();
    clock.stop();
    const before = steps.length;
    ctx.currentTime += 10;
    timer.fire(); // the worker message that was already in flight
    expect(steps.length).toBe(before);
  });

  it('honours a custom scheduleAheadS horizon', () => {
    const ctx = { currentTime: 0 } as unknown as AudioContext;
    const timer = new ManualTimer();
    const clock = new Clock(ctx, { timer, scheduleAheadS: 0.3 });
    const whens: number[] = [];
    clock.onTick((_step, when) => whens.push(when));

    clock.start(); // grid starts at 0.05; 0.3s horizon covers steps at 0.05/0.175/0.3 (- ε)
    expect(whens.length).toBeGreaterThan(1);
    expect(Math.max(...whens)).toBeLessThan(0.3 + 0.05);
    clock.stop();
  });
});

describe('TimeoutTimer', () => {
  it('fires repeatedly at the interval and stops cleanly', () => {
    vi.useFakeTimers();
    const timer = new TimeoutTimer();
    const cb = vi.fn();
    timer.start(cb, 25);

    vi.advanceTimersByTime(25);
    vi.advanceTimersByTime(25);
    expect(cb).toHaveBeenCalledTimes(2);

    timer.stop();
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('does not re-arm when the callback itself calls stop()', () => {
    vi.useFakeTimers();
    const timer = new TimeoutTimer();
    const cb = vi.fn(() => timer.stop());
    timer.start(cb, 25);

    vi.advanceTimersByTime(25);
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('WorkerTimer', () => {
  it('speaks the start/stop message protocol and relays wakeups', () => {
    const instances: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      posted: unknown[] = [];
      constructor() {
        instances.push(this);
      }
      postMessage(m: unknown): void {
        this.posted.push(m);
      }
    }
    vi.stubGlobal('Worker', FakeWorker);

    const timer = new WorkerTimer();
    const cb = vi.fn();
    timer.start(cb, 25);

    expect(instances).toHaveLength(1);
    const w = instances[0]!;
    expect(w.posted).toEqual([{ cmd: 'start', ms: 25 }]);

    w.onmessage!({} as MessageEvent);
    expect(cb).toHaveBeenCalledTimes(1);

    timer.stop();
    expect(w.posted).toEqual([{ cmd: 'start', ms: 25 }, { cmd: 'stop' }]);

    // In-flight wakeup after stop must not reach the callback.
    w.onmessage!({} as MessageEvent);
    expect(cb).toHaveBeenCalledTimes(1);

    // Restart reuses the same worker — no per-play spawn.
    timer.start(cb, 25);
    expect(instances).toHaveLength(1);
  });
});
