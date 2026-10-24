import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudibleTimeline } from '../../src/ui/audible';
import { TestClock } from '../audio/transport/test-clock';

/**
 * transport-position.md REQ-the-playhead-is-drawn-when-it-is-heard (v8, regression). The clock hands a
 * step out up to 100 ms before it sounds, and every playhead display painted on
 * that hand-off — running ahead of the music.
 */

function rig() {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 };
  const clock = new TestClock();
  const timeline = new AudibleTimeline({ ctx, clock });
  /** Advance the audio clock and the timers together. */
  const advance = (s: number): void => {
    ctx.currentTime += s;
    vi.advanceTimersByTime(s * 1000);
  };
  return { ctx, clock, timeline, advance };
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('AudibleTimeline', () => {
  it('reports a step when it is heard, not when it is scheduled', () => {
    const { clock, timeline, advance } = rig();
    const heard: number[] = [];
    timeline.onStep((s) => heard.push(s));
    clock.fireStart(0);
    clock.fireTick(0.08); // step 0, scheduled 80 ms ahead
    expect(heard).toEqual([]);
    expect(timeline.step).toBe(0); // the start step until the first one sounds
    advance(0.079);
    expect(heard).toEqual([]);
    advance(0.002);
    expect(heard).toEqual([0]);
    clock.fireTick(0.2); // step 1
    advance(0.05);
    expect(timeline.step).toBe(0); // still hearing step 0
    advance(0.08);
    expect(timeline.step).toBe(1);
  });

  it('runs work whose time has already passed straight away', () => {
    const { ctx, timeline } = rig();
    ctx.currentTime = 1;
    const fn = vi.fn();
    timeline.at(0.5, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a stop cancels everything still pending', () => {
    const { clock, timeline, advance } = rig();
    const heard: number[] = [];
    timeline.onStep((s) => heard.push(s));
    const later = vi.fn();
    clock.fireStart(0);
    clock.fireTick(0.05);
    timeline.at(0.09, later);
    clock.fireStop();
    advance(0.2);
    expect(heard).toEqual([]);
    expect(later).not.toHaveBeenCalled();
  });
});
