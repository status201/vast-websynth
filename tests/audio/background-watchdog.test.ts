import { describe, it, expect, vi } from 'vitest';
import { BackgroundAudioWatchdog } from '../../src/audio/background-watchdog';
import type { TickTimer } from '../../src/audio/transport/tick-timer';

/**
 * The background watchdog (audio-lifecycle.md REQ-9..REQ-12).
 *
 * Everything it depends on is injected — the document, the sampling timer, the
 * wall clock — so a test drives real time, audio time and the audio thread's own
 * underrun reports independently, which is the whole point: the trip must follow
 * the *measurement*, never the device.
 */
function harness(opts: { renderCapacity?: boolean; busy?: boolean } = {}) {
  let hidden = false;
  let visibilityFn: (() => void) | null = null;
  const doc = {
    get hidden() { return hidden; },
    addEventListener: (_t: 'visibilitychange', fn: () => void) => { visibilityFn = fn; },
  };

  // Injected timer: the test fires sampling wakeups by hand.
  let sample: (() => void) | null = null;
  const timer: TickTimer = {
    start: (cb) => { sample = cb; },
    stop: () => { sample = null; },
  };

  const capacityListeners: Array<(e: AudioRenderCapacityEvent) => void> = [];
  const renderCapacity = {
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn((_t: 'update', fn: (e: AudioRenderCapacityEvent) => void) => {
      capacityListeners.push(fn);
    }),
    removeEventListener: vi.fn((_t: 'update', fn: (e: AudioRenderCapacityEvent) => void) => {
      const i = capacityListeners.indexOf(fn);
      if (i >= 0) capacityListeners.splice(i, 1);
    }),
  };

  const ctx = {
    state: 'running' as AudioContextState,
    currentTime: 0,
    ...(opts.renderCapacity === false ? {} : { renderCapacity }),
  };

  let wall = 0; // ms
  const onGlitch = vi.fn();
  const watchdog = new BackgroundAudioWatchdog(ctx as unknown as AudioContext, {
    onGlitch,
    isBusy: () => opts.busy ?? false,
    doc,
    timer,
    now: () => wall,
  });
  watchdog.start();

  return {
    watchdog,
    onGlitch,
    ctx,
    renderCapacity,
    hide: () => { hidden = true; visibilityFn?.(); },
    show: () => { hidden = false; visibilityFn?.(); },
    /** Report one window from the audio thread. */
    underruns: (ratio: number) => {
      for (const fn of [...capacityListeners]) {
        fn({ underrunRatio: ratio, averageLoad: 0.5, peakLoad: 0.9, timestamp: wall } as AudioRenderCapacityEvent);
      }
    },
    /** Advance both clocks and fire one sampling wakeup. `audioS` may lag. */
    tick: (wallS: number, audioS = wallS) => {
      wall += wallS * 1000;
      ctx.currentTime += audioS;
      sample?.();
    },
    isSampling: () => sample !== null,
  };
}

describe('BackgroundAudioWatchdog', () => {
  it('only watches while the page is hidden', () => {
    const h = harness();
    expect(h.isSampling()).toBe(false);
    expect(h.watchdog.diagnostics.watching).toBe(false);

    h.hide();
    expect(h.watchdog.diagnostics.watching).toBe(true);
    expect(h.renderCapacity.start).toHaveBeenCalledWith({ updateInterval: 0.25 });
    expect(h.isSampling()).toBe(true);

    h.show();
    expect(h.watchdog.diagnostics.watching).toBe(false);
    expect(h.renderCapacity.stop).toHaveBeenCalled();
    expect(h.isSampling()).toBe(false);
  });

  it('suspends after two consecutive underrunning windows', () => {
    const h = harness();
    h.hide();
    h.underruns(0.08);   // bad, but under the severe bar
    expect(h.onGlitch).not.toHaveBeenCalled(); // one window is not a verdict
    h.underruns(0.06);
    expect(h.onGlitch).toHaveBeenCalledTimes(1);
    expect(h.watchdog.diagnostics.suspensions).toBe(1);
    // …and it stops watching, so it cannot fire again for the same episode.
    expect(h.watchdog.diagnostics.watching).toBe(false);
    h.underruns(0.5);
    expect(h.onGlitch).toHaveBeenCalledTimes(1);
  });

  it('leaves a device that plays cleanly in the background alone', () => {
    const h = harness();
    h.hide();
    for (let i = 0; i < 40; i++) {
      h.underruns(0);
      h.tick(0.5);
    }
    expect(h.onGlitch).not.toHaveBeenCalled();
    expect(h.watchdog.diagnostics.watching).toBe(true);
  });

  // The Pixel that prompted all this measured its audio clock at 36 % of real
  // time: waiting a second window only buys confirmation, paid for in crackle.
  it('trips on the first window when the reading is severe', () => {
    const h = harness();
    h.hide();
    h.underruns(0.4);
    expect(h.onGlitch).toHaveBeenCalledTimes(1);
  });

  it('trips on the first window when the audio clock is barely running', () => {
    const h = harness({ renderCapacity: false });
    h.hide();
    h.tick(1, 0.36); // 36 % of real time — the measured Pixel 8a case
    expect(h.onGlitch).toHaveBeenCalledTimes(1);
  });

  it('still needs two windows for a marginal reading (edge)', () => {
    const h = harness({ renderCapacity: false });
    h.hide();
    h.tick(1, 0.8); // bad (< 90 %) but not severe
    expect(h.onGlitch).not.toHaveBeenCalled();
    h.tick(1, 0.8);
    expect(h.onGlitch).toHaveBeenCalledTimes(1);
  });

  it('resets on a clean window between two bad ones (edge)', () => {
    const h = harness();
    h.hide();
    h.underruns(0.09); // bad — could be the hide transition itself
    h.underruns(0);    // clean
    h.underruns(0.09); // bad again, but the count restarted
    expect(h.onGlitch).not.toHaveBeenCalled();
  });

  // REQ-11 — an export records the live output; suspending truncates the file.
  it('never suspends while a capture is running', () => {
    const h = harness({ busy: true });
    h.hide();
    for (let i = 0; i < 6; i++) h.underruns(0.5);
    expect(h.onGlitch).not.toHaveBeenCalled();
  });

  it('trips on audio-clock drift where underruns cannot be seen', () => {
    const h = harness({ renderCapacity: false });
    h.hide();
    expect(h.watchdog.diagnostics.supported).toBe(false);
    // The renderer is frozen: wall time runs, audio time barely moves. Severe
    // by any measure, so one window is the whole verdict.
    h.tick(30, 0.2);
    expect(h.onGlitch).toHaveBeenCalledTimes(1);
  });

  it('does not read drift as a fault when the audio clock keeps up', () => {
    const h = harness({ renderCapacity: false });
    h.hide();
    for (let i = 0; i < 10; i++) h.tick(0.5, 0.5);
    expect(h.onGlitch).not.toHaveBeenCalled();
    expect(h.watchdog.diagnostics.driftRatio).toBeCloseTo(1, 3);
  });

  it('ignores a window too short to judge (edge)', () => {
    const h = harness({ renderCapacity: false });
    h.hide();
    // Three wakeups inside one sampling window, each showing a stalled audio
    // clock — too little elapsed wall time to mean anything. (They accumulate
    // rather than reset, so the verdict lands once the window is long enough.)
    h.tick(0.05, 0);
    h.tick(0.05, 0);
    h.tick(0.05, 0);
    expect(h.onGlitch).not.toHaveBeenCalled();
    h.tick(0.15, 0); // now past SAMPLE_S — and stalled is as severe as it gets
    expect(h.onGlitch).toHaveBeenCalledTimes(1);
  });

  it('stops watching a context the OS suspended under it', () => {
    const h = harness();
    h.hide();
    h.ctx.state = 'suspended';
    h.tick(1, 0);
    expect(h.watchdog.diagnostics.watching).toBe(false);
    expect(h.onGlitch).not.toHaveBeenCalled(); // nothing left to suspend
  });

  it('does not start watching a context that is already suspended', () => {
    const h = harness();
    h.ctx.state = 'suspended';
    h.hide();
    expect(h.watchdog.diagnostics.watching).toBe(false);
    expect(h.renderCapacity.start).not.toHaveBeenCalled();
  });

  it('reports the worst underrun it saw, past the return to the foreground', () => {
    const h = harness();
    h.hide();
    h.underruns(0.004);
    h.underruns(0.031);
    h.underruns(0);
    h.show();
    const d = h.watchdog.diagnostics;
    expect(d.supported).toBe(true);
    expect(d.worstUnderrunRatio).toBeCloseTo(0.031, 5);
    expect(d.underrunRatio).toBe(0);
    expect(d.watching).toBe(false);
  });
});
