import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Scope,
  SCOPE_WATCHDOG_MS,
  SCOPE_STALL_MS,
  SCOPE_PAINT_STALL_MS,
  CONTEXT_RESTORE_MS,
  REBUILD_MIN_GAP_MS,
} from '../../src/ui/components/scope';

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
 *
 * v16 (REQ-32..38): it happened again, on Chrome desktop, with a *frozen* last
 * frame rather than a black one — so the backing store was fine and the loop had
 * simply stopped. v12 made `start()` restartable but left every trigger for it
 * event-driven and one-shot, and left `contextlost` -> `stop()` waiting forever.
 * The cases below drive the watchdog over fake timers and a stubbed
 * `performance.now`, because the component now compares that clock against its
 * own frame timestamps.
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
  let cancels = 0;
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    if (pending.delete(id)) cancels++;
  });
  return {
    get queued() { return pending.size; },
    /** Frames actually cancelled — how "did a healthy mutator churn the loop" is asked. */
    get cancels() { return cancels; },
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
    /** What a browser that HAS the API answers once the context is gone (REQ-36). */
    loseContext: () => { target['isContextLost'] = () => true; },
  };
}

/**
 * A 2D context on a browser with no `isContextLost` at all — the proxy's `get` trap
 * returns a recording stub for every unknown prop, so without this the component
 * would see a function that returns `undefined`, which is not the same thing.
 */
function ctxWithoutLossApi() {
  const painter = recordingCtx();
  Reflect.set(painter.ctx as unknown as object, 'isContextLost', undefined);
  return painter;
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
function sizeCanvas(el: HTMLCanvasElement, w = 320, h = 120): void {
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
}

function mountScope(painter = recordingCtx()) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    painter.ctx as unknown as RenderingContext,
  );
  // A real parent, so REQ-35's `replaceWith` is exercised rather than silently
  // no-oping the way it does on an unparented node.
  const wrap = document.createElement('div');
  document.body.appendChild(wrap);
  const scope = new Scope({ mono: fakeAnalyser() });
  wrap.appendChild(scope.el);
  sizeCanvas(scope.el);
  return { scope, painter, wrap };
}

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
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

/**
 * v16 — the supervisor (REQ-32..38). These run on fake timers so the ~1 Hz watchdog
 * and the component's `performance.now()` comparisons advance together; `now` starts
 * well above zero so no age is accidentally measured from the epoch.
 */
describe('Scope liveness watchdog (v16)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'], now: 10_000 });
  });
  afterEach(() => { vi.useRealTimers(); });

  /** Advance the shared clock past `ms` and let every due watchdog tick run. */
  const tick = (ms: number): void => { vi.advanceTimersByTime(ms); };

  it('restarts a loop the browser stopped delivering (REQ-33)', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();

    // A renderer freeze: the queued callback simply never arrives. No event
    // announces it, which is precisely why v12's event-driven recovery missed it.
    frames.dropQueued();
    expect(frames.queued).toBe(0);

    tick(SCOPE_STALL_MS + SCOPE_WATCHDOG_MS);
    expect(frames.queued).toBe(1);
    expect(scope.health.restarts).toBeGreaterThanOrEqual(1);

    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });

  it('does nothing at all while the tab is hidden (REQ-33, perf-mode REQ-6)', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();

    setHidden(true);
    expect(frames.queued).toBe(0);

    tick(SCOPE_WATCHDOG_MS * 10);
    // The pause is a requirement, not an accident: a supervisor that revived a
    // backgrounded scope would break the very contract v16 promises to keep.
    expect(frames.queued).toBe(0);
    expect(scope.health.restarts).toBe(0);
    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(false);

    scope.destroy();
  });

  it('leaves a healthy loop completely alone (REQ-33)', () => {
    const frames = frameScheduler();
    const { scope } = mountScope();
    const cancelsAtStart = frames.cancels;

    // Deliver frames the whole way, the way a healthy browser does.
    for (let i = 0; i < 5; i++) {
      tick(SCOPE_WATCHDOG_MS / 2);
      frames.run(performance.now());
      tick(SCOPE_WATCHDOG_MS / 2);
      frames.run(performance.now());
    }

    expect(scope.health.restarts).toBe(0);
    expect(frames.cancels).toBe(cancelsAtStart);
    expect(frames.queued).toBe(1);
    expect(scope.health.drawing).toBe(true);

    scope.destroy();
  });

  it('measures rather than rebuilding when the layout box is gone (REQ-33)', () => {
    const frames = frameScheduler();
    const { scope } = mountScope();
    const before = scope.el;

    // Frames keep arriving, but `draw()` early-returns on syncSize — a live loop
    // painting nothing. A rebuild would be the wrong answer: a panel with no box
    // has nothing to draw.
    sizeCanvas(scope.el, 0, 0);
    for (let i = 0; i < 4; i++) {
      tick(SCOPE_PAINT_STALL_MS / 2);
      frames.run(performance.now());
    }

    expect(scope.health.hasBox).toBe(false);
    expect(scope.health.rebuilds).toBe(0);
    expect(scope.el).toBe(before);

    scope.destroy();
  });

  it('stops waiting for a contextrestored that never comes (REQ-34, regression)', () => {
    const frames = frameScheduler();
    const { scope, painter, wrap } = mountScope();
    const before = scope.el;

    const lost = new Event('contextlost', { cancelable: true });
    scope.el.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(frames.queued).toBe(0);

    // REQ-24's pause is honoured for the window we asked for...
    tick(CONTEXT_RESTORE_MS / 2);
    expect(frames.queued).toBe(0);

    // ...and then it is over. v12 left this waiting for the life of the page, on a
    // tab that never stopped being visible — note there is no visibilitychange here.
    tick(CONTEXT_RESTORE_MS + SCOPE_WATCHDOG_MS);
    expect(scope.health.rebuilds).toBe(1);
    expect(frames.queued).toBe(1);

    // A *different* element, in the same slot, carrying the same identity — the
    // only escape there is, since getContext('2d') would hand back the dead one.
    expect(scope.el).not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(wrap.contains(scope.el)).toBe(true);
    expect(scope.el.dataset.testid).toBe('scope-canvas');
    expect(scope.el.className).toBe(before.className);

    // The browser lays the replacement out from the same CSS class; jsdom does not,
    // so the box is re-stubbed here and nowhere else.
    sizeCanvas(scope.el);
    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(true);
    // REQ-15's change-only mirror was cleared with the element, so the readouts
    // come back rather than being suppressed for the life of the page.
    expect(scope.el.dataset.waveGain).toBeDefined();

    scope.destroy();
  });

  it('carries the click listener onto the replacement (REQ-35)', () => {
    frameScheduler();
    const { scope } = mountScope();
    scope.el.dispatchEvent(new Event('contextlost', { cancelable: true }));
    tick(CONTEXT_RESTORE_MS + SCOPE_WATCHDOG_MS);

    const replaced = scope.el;
    replaced.dataset.peak = '-12.0';
    replaced.dispatchEvent(new Event('click'));
    // resetPeak clears the mirror; if the listener had not moved, nothing happens.
    expect(replaced.dataset.peak).toBeUndefined();

    // And the context listeners moved too: a second loss is still acknowledged.
    const again = new Event('contextlost', { cancelable: true });
    replaced.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(true);
    expect(scope.health.losses).toBe(2);

    scope.destroy();
  });

  it('never trades a live canvas for one it cannot draw into (REQ-35, edge)', () => {
    frameScheduler();
    const { scope } = mountScope();
    const before = scope.el;

    scope.el.dispatchEvent(new Event('contextlost', { cancelable: true }));
    // The replacement cannot give us a context — abandoning is the only safe move.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    tick(CONTEXT_RESTORE_MS + SCOPE_WATCHDOG_MS);

    expect(scope.el).toBe(before);
    expect(scope.health.rebuilds).toBe(0);

    scope.destroy();
  });

  it('the watchdog dies with the scope (REQ-33)', () => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();
    scope.destroy();

    tick(SCOPE_WATCHDOG_MS * 10);
    expect(frames.queued).toBe(0);
    painter.reset();
    frames.run(16);
    expect(painter.drew()).toBe(false);
  });

  it('reports what the panel is doing (REQ-38)', () => {
    frameScheduler();
    const { scope } = mountScope();

    expect(scope.health.drawing).toBe(true);
    expect(scope.health.contextLost).toBe(false);
    expect(scope.health.losses).toBe(0);

    scope.el.dispatchEvent(new Event('contextlost', { cancelable: true }));
    expect(scope.health.losses).toBe(1);
    tick(CONTEXT_RESTORE_MS + SCOPE_WATCHDOG_MS);
    expect(scope.health.rebuilds).toBe(1);
    // Written on increment only, per REQ-15's change-only rule.
    expect(scope.el.dataset.rebuilds).toBe('1');

    scope.destroy();
  });
});

/**
 * Every control is a way back (REQ-37). The user's instinct on a dead panel is to
 * poke a button, and until v16 that was the one thing that could not help — these
 * setters write a field the loop was going to read.
 */
describe('Scope controls as recovery paths (v16, REQ-37)', () => {
  const mutators: [string, (s: Scope) => void][] = [
    ['setMode', (s) => s.setMode('spectrum')],
    ['setChannels', (s) => s.setChannels('mono')],
    ['setZones', (s) => s.setZones(true)],
    ['resetPeak', (s) => s.resetPeak()],
    ['setFps', (s) => s.setFps(30)],
    ['setFftSize', (s) => s.setFftSize(512)],
  ];

  it.each(mutators)('%s revives a loop the browser stopped delivering', (_name, use) => {
    const frames = frameScheduler();
    const { scope, painter } = mountScope();

    // Give the loop a real frame first, so the stall below is measured from it.
    frames.run(16);
    frames.dropQueued();
    expect(frames.queued).toBe(0);

    // The component compares performance.now() against its own frame timestamp, so
    // the stall has to be real time, not a flag.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + SCOPE_STALL_MS + 1);
    use(scope);
    expect(frames.queued).toBe(1);

    painter.reset();
    // Well past any target interval, so `setFps(30)`'s own throttle is not what
    // this case ends up measuring.
    frames.run(2000);
    expect(painter.drew()).toBe(true);

    scope.destroy();
  });

  it('costs a healthy loop nothing at all', () => {
    const frames = frameScheduler();
    const { scope } = mountScope();
    frames.run(16);
    const cancelsAtStart = frames.cancels;

    scope.setMode('spectrum');
    scope.setZones(true);
    scope.setChannels('mono');

    // No cancel/re-arm churn, no restart counted: `ensureLive` returned on its guard.
    expect(frames.cancels).toBe(cancelsAtStart);
    expect(frames.queued).toBe(1);
    expect(scope.health.restarts).toBe(0);

    scope.destroy();
  });

  it('a window focus and a Page Lifecycle resume both revive it', () => {
    for (const fire of [
      () => window.dispatchEvent(new Event('focus')),
      () => document.dispatchEvent(new Event('resume')),
    ]) {
      const frames = frameScheduler();
      const { scope } = mountScope();
      frames.run(16);
      frames.dropQueued();
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + SCOPE_STALL_MS + 1);

      fire();
      expect(frames.queued).toBe(1);
      scope.destroy();
      vi.restoreAllMocks();
    }
  });

  it('an element focus inside the app is not a window focus', () => {
    const frames = frameScheduler();
    const { scope, wrap } = mountScope();
    frames.run(16);
    frames.dropQueued();
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + SCOPE_STALL_MS + 1);

    // `focus` does not bubble; a capturing listener would see every knob and button
    // in the app and make `ensureLive` a hot path.
    const button = document.createElement('button');
    wrap.appendChild(button);
    button.dispatchEvent(new Event('focus'));
    expect(frames.queued).toBe(0);

    scope.destroy();
  });

  it('does not restart while the tab is hidden', () => {
    const frames = frameScheduler();
    const { scope } = mountScope();
    setHidden(true);
    expect(frames.queued).toBe(0);

    scope.setMode('spectrum');
    scope.setZones(true);
    expect(frames.queued).toBe(0);

    scope.destroy();
  });
});

describe('Scope lost-context detection (v16, REQ-36)', () => {
  it('replaces the canvas as soon as the browser says the context is gone', () => {
    frameScheduler();
    const { scope, painter } = mountScope();
    const before = scope.el;

    // No contextlost event at all — this is the browser's own answer, which is the
    // free signal. No pixel read-back is involved, and none ever should be.
    painter.loseContext();
    expect(scope.health.contextLost).toBe(true);

    scope.setMode('spectrum');
    expect(scope.el).not.toBe(before);
    expect(scope.health.rebuilds).toBe(1);

    scope.destroy();
  });

  it('a GPU that never comes back is retried, not rebuilt every second', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    frameScheduler();
    const { scope, painter } = mountScope();

    // A dead GPU process answers truthfully every single time it is asked. Without
    // the rate limit the ~1 Hz watchdog would mint a canvas and a bitmap per second
    // for the life of the page — a recovery that is really a leak.
    painter.loseContext();
    vi.advanceTimersByTime(REBUILD_MIN_GAP_MS * 3);

    expect(scope.health.rebuilds).toBeGreaterThanOrEqual(1);
    expect(scope.health.rebuilds).toBeLessThanOrEqual(4);

    scope.destroy();
    vi.useRealTimers();
  });

  it('a browser with no isContextLost is simply never asked', () => {
    const frames = frameScheduler();
    const painter = ctxWithoutLossApi();
    const { scope } = mountScope(painter);
    frames.run(16);

    // Nothing to ask, so nothing is guessed: the loop just keeps running.
    expect(scope.health.contextLost).toBe(false);
    scope.setMode('spectrum');
    expect(scope.health.rebuilds).toBe(0);
    expect(frames.queued).toBe(1);

    scope.destroy();
  });
});
