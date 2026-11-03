import { vi } from 'vitest';

/**
 * Shared by the scope suites (scope-lifecycle, scope-sleep): a real `Scope` over
 * jsdom with an injected frame scheduler, so "is a frame queued" and "did it
 * draw" are both directly observable.
 */

/** A hand-driven `requestAnimationFrame`, with real cancel semantics. */
export function frameScheduler() {
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
export function recordingCtx() {
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
    /** What a browser that HAS the API answers once the context is gone (REQ-scope-detection-is-free-or-it-does-not-happen). */
    loseContext: () => { target['isContextLost'] = () => true; },
  };
}

/** Build a Scope that can actually paint: jsdom reports a 0×0 box otherwise. */
export function sizeCanvas(el: HTMLCanvasElement, w = 320, h = 120): void {
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
}
