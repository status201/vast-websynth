import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scope } from '../../src/ui/components/scope';

/**
 * Scope recovery (scope.md v12, REQ-22..REQ-25).
 *
 * A device report: the scope went black while the app was backgrounded and
 * **stayed** black on return, even once audio was running again. The canvas is
 * transparent — the black is the bezel behind it — so a black panel means the
 * loop stopped painting, and every route to that had no way back.
 *
 * These cases drive a real `Scope` over jsdom with an injected frame scheduler,
 * so "is a frame queued" and "did it draw" are both directly observable.
 */

/** A hand-driven `requestAnimationFrame`, with real cancel semantics. */
function frameScheduler() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pending.delete(id); });
  return {
    get queued() { return pending.size; },
    /** Run whatever is queued. A throw is caught, as the browser's event loop does. */
    run(ts: number): unknown[] {
      const due = [...pending.values()];
      pending.clear();
      const thrown: unknown[] = [];
      for (const cb of due) { try { cb(ts); } catch (e) { thrown.push(e); } }
      return thrown;
    },
    /** What a renderer freeze does to a queued callback: it never arrives. */
    dropQueued(): void { pending.clear(); },
  };
}

/** A 2D context that records the calls made against it. */
function recordingCtx() {
  const calls: string[] = [];
  const grad = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {};
  let failNextClear = false;
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === 'createLinearGradient') return () => grad;
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        calls.push(prop);
        if (prop === 'clearRect' && failNextClear) {
          failNextClear = false;
          throw new Error('context is toast');
        }
        return args.length ? undefined : undefined;
      };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  });
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    calls,
    drew: () => calls.includes('clearRect'),
    reset: () => { calls.length = 0; },
    breakNextDraw: () => { failNextClear = true; },
  };
}

const fakeAnalyser = (): AnalyserNode => ({
  fftSize: 1024,
  frequencyBinCount: 512,
  smoothingTimeConstant: 0.2,
  getFloatTimeDomainData: () => undefined,
  getByteFrequencyData: () => undefined,
} as unknown as AnalyserNode);

let hidden = false;
const setHidden = (v: boolean): void => {
  hidden = v;
  document.dispatchEvent(new Event('visibilitychange'));
};

/** Build a Scope that can actually paint: jsdom reports a 0×0 box otherwise. */
function mountScope(painter = recordingCtx()) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    painter.ctx as unknown as RenderingContext,
  );
  const scope = new Scope({ mono: fakeAnalyser() });
  Object.defineProperty(scope.el, 'clientWidth', { value: 320, configurable: true });
  Object.defineProperty(scope.el, 'clientHeight', { value: 120, configurable: true });
  return { scope, painter };
}

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Scope redraw loop recovery', () => {
  it('comes back after the tab was hidden (REQ-25)', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();
    expect(frames.queued).toBe(1); // the constructor started it

    setHidden(true);
    expect(frames.queued).toBe(0); // paused — a hidden scope is wasted work
    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(false);

    setHidden(false);
    expect(frames.queued).toBe(1);
    frames.run(32);
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });

  it('restarts after a frame the browser dropped (REQ-22, regression)', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();

    // What a renderer freeze does: the queued callback never arrives, so the
    // loop's own re-arm never runs and `running` stays latched true. The old
    // `if (this.running) return` made every restart from here a no-op forever.
    frames.dropQueued();
    expect(frames.queued).toBe(0);

    setHidden(false); // returning to the foreground must re-arm regardless
    expect(frames.queued).toBe(1);
    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });

  it('never queues more than one frame, however often it is restarted (REQ-22)', () => {
    const frames = frameScheduler();
    const { scope } = mountScope();
    setHidden(false);
    setHidden(false);
    window.dispatchEvent(new Event('pageshow'));
    expect(frames.queued).toBe(1);
    scope.destroy();
  });

  it('survives a frame that throws (REQ-23)', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();

    painter.breakNextDraw();
    const thrown = frames.run(16);
    // The error is not swallowed — an invisible error is how this shipped —
    // but the next frame was queued before the draw, so the loop lives.
    expect(thrown).toHaveLength(1);
    expect(frames.queued).toBe(1);

    painter.reset();
    frames.run(32);
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });

  it('restarts from a pageshow, which a bfcache restore fires (REQ-25)', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();
    frames.dropQueued();

    window.dispatchEvent(new Event('pageshow'));
    expect(frames.queued).toBe(1);
    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });

  it('stops for good once destroyed', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();
    scope.destroy();
    expect(frames.queued).toBe(0);

    // Every listener is gone, so nothing can restart a destroyed scope.
    setHidden(false);
    window.dispatchEvent(new Event('pageshow'));
    expect(frames.queued).toBe(0);
    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(false);
  });
});

describe('Scope canvas context loss (REQ-24)', () => {
  it('asks for the context back and pauses until it arrives', () => {
    const frames = frameScheduler();
    const { scope } = mountScope();

    const lost = new Event('contextlost', { cancelable: true });
    scope.el.dispatchEvent(lost);
    // Without preventDefault the browser never restores a lost 2D context, and
    // the panel is blank for the life of the page.
    expect(lost.defaultPrevented).toBe(true);
    expect(frames.queued).toBe(0);

    scope.destroy();
  });

  it('repaints once the context is restored', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();
    scope.el.dispatchEvent(new Event('contextlost', { cancelable: true }));

    scope.el.dispatchEvent(new Event('contextrestored'));
    expect(frames.queued).toBe(1);
    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });

  it('lets go of both listeners on destroy', () => {
    const frames = frameScheduler();
    const { scope } = mountScope();
    scope.destroy();
    scope.el.dispatchEvent(new Event('contextrestored'));
    expect(frames.queued).toBe(0);
  });
});

describe('Scope.setFps guard (REQ-25)', () => {
  it.each([0, -30, NaN, Infinity])('keeps drawing when given %p', (fps) => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();
    scope.setFps(fps as number);

    painter.reset();
    frames.run(16);
    // A NaN/Infinity frame interval is a loop that spins and never draws — the
    // same black panel by a fourth route.
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });

  it('still throttles a real target rate', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();
    scope.setFps(30); // 33.3 ms between frames

    frames.run(1000);
    painter.reset();
    frames.run(1010); // only 10 ms later — too soon
    expect(painter.drew()).toBe(false);
    frames.run(1040); // 40 ms later — due
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });
});
