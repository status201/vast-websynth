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
