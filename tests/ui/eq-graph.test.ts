import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EqGraph } from '../../src/ui/components/eq-graph';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { EQ_BANDS, EQ_BAND_COUNT } from '../../src/state/eq';
import { freqToFrac } from '../../src/ui/components/scope';

/**
 * The drawable curve — `specs/features/equalizer.md` REQ-the-curve-is-drawn-by-dragging/REQ-the-graph-computes-from-bus-values.
 *
 * jsdom has no 2D context and no layout, so this drives a real `EqGraph` over a
 * recording context and an injected frame scheduler, exactly as the Scope's
 * lifecycle suite does. That makes "is a frame queued" and "did it paint"
 * directly observable, which is what the coalescing and gating cases need.
 */

const W = 800;
const H = 160;

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
    run(): void {
      const due = [...pending.values()];
      pending.clear();
      for (const cb of due) cb(0);
    },
  };
}

/** A 2D context that records the calls made against it. */
function recordingCtx() {
  const calls: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop in t) return t[prop];
      return (...args: unknown[]) => { calls.push(prop); void args; };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  });
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    drew: () => calls.includes('clearRect'),
    reset: () => { calls.length = 0; },
  };
}

function mount(prefix = 'fx.eq') {
  const painter = recordingCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    painter.ctx as unknown as RenderingContext,
  );
  const bus = new ParamBus();
  registerDefaults(bus);
  const graph = new EqGraph({ bus, prefix, lane: 'seq', sampleRate: 48000 });
  Object.defineProperty(graph.el, 'clientWidth', { value: W, configurable: true });
  Object.defineProperty(graph.el, 'clientHeight', { value: H, configurable: true });
  document.body.appendChild(graph.el);
  return { bus, graph, painter, prefix };
}

/** Canvas x of a band's centre, on the axis the component draws. */
const xOf = (i: number) => freqToFrac(EQ_BANDS[i]!.hz) * W;

/**
 * A pointer event carrying both the client coords the component prefers and the
 * offsets it falls back to — jsdom reports a 0x0 rect, which is exactly the
 * fallback path `posOf` exists to cover.
 */
function ptr(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  const e = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init,
  }) as unknown as PointerEvent;
  Object.defineProperty(e, 'offsetX', { value: x, configurable: true });
  Object.defineProperty(e, 'offsetY', { value: y, configurable: true });
  Object.defineProperty(e, 'pointerId', { value: 1, configurable: true });
  Object.defineProperty(e, 'pointerType', { value: 'mouse', configurable: true });
  return e;
}

const canvasOf = (graph: EqGraph) => graph.el.querySelector('canvas')!;

/** The y that means a given dB, mirroring the component's own mapping. */
const yForDb = (db: number): number => {
  const plotH = H - 13; // RULER_H
  return plotH / 2 - (db / 21) * (plotH / 2); // DB_VIEW
};

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('drawing the curve (REQ-the-curve-is-drawn-by-dragging)', () => {
  it('writes the band under a tap', () => {
    frameScheduler();
    const { bus, graph } = mount();
    canvasOf(graph).dispatchEvent(ptr('pointerdown', xOf(3), yForDb(-9)));
    expect(bus.get('fx.eq.b3')).toBeCloseTo(-9, 1);
    // Its neighbours are untouched by a tap.
    expect(bus.get('fx.eq.b2')).toBe(0);
    expect(bus.get('fx.eq.b4')).toBe(0);
  });

  it('paints every band a fast drag crosses, none skipped', () => {
    // The failure this prevents: a pointer that jumps four columns between two
    // moves leaves holes in the drawn line.
    frameScheduler();
    const { bus, graph } = mount();
    canvasOf(graph).dispatchEvent(ptr('pointerdown', xOf(1), yForDb(-12)));
    window.dispatchEvent(ptr('pointermove', xOf(6), yForDb(-12)));

    for (let i = 1; i <= 6; i++) {
      expect(bus.get(`fx.eq.b${i}`), `band ${i}`).toBeLessThan(-1);
    }
    expect(bus.get('fx.eq.b0')).toBe(0);
    expect(bus.get('fx.eq.b7')).toBe(0);
  });

  it('interpolates the height across the bands it crosses', () => {
    // A sweep from flat to full cut should land a ramp, not a step: the
    // in-between bands take in-between values.
    frameScheduler();
    const { bus, graph } = mount();
    canvasOf(graph).dispatchEvent(ptr('pointerdown', xOf(1), yForDb(0)));
    window.dispatchEvent(ptr('pointermove', xOf(5), yForDb(-16)));

    const gains = [1, 2, 3, 4, 5].map((i) => bus.get(`fx.eq.b${i}`));
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]!, `band ${i + 1} vs ${i}`).toBeLessThan(gains[i - 1]! + 0.001);
    }
    expect(gains[4]!).toBeLessThan(-12);
  });

  it('drags backwards as happily as forwards', () => {
    frameScheduler();
    const { bus, graph } = mount();
    canvasOf(graph).dispatchEvent(ptr('pointerdown', xOf(6), yForDb(-10)));
    window.dispatchEvent(ptr('pointermove', xOf(2), yForDb(-10)));
    for (let i = 2; i <= 6; i++) {
      expect(bus.get(`fx.eq.b${i}`), `band ${i}`).toBeLessThan(-1);
    }
  });

  it('takes a quarter of the travel while Shift is held', () => {
    frameScheduler();
    const { bus, graph } = mount();
    canvasOf(graph).dispatchEvent(ptr('pointerdown', xOf(3), yForDb(-12), { shiftKey: true }));
    const fine = bus.get('fx.eq.b3');
    expect(fine).toBeGreaterThan(-12);
    expect(fine).toBeCloseTo(-3, 1);
  });

  it('resets a band on a double-tap, leaving its neighbours alone', () => {
    frameScheduler();
    const { bus, graph } = mount();
    const c = canvasOf(graph);
    bus.set('fx.eq.b2', -9);
    bus.set('fx.eq.b3', -9);

    c.dispatchEvent(ptr('pointerdown', xOf(3), yForDb(-9)));
    window.dispatchEvent(ptr('pointerup', xOf(3), yForDb(-9)));
    c.dispatchEvent(ptr('pointerdown', xOf(3), yForDb(-9)));

    expect(bus.get('fx.eq.b3')).toBe(0);
    expect(bus.get('fx.eq.b2')).toBe(-9);
  });

  it('stops writing once the pointer is released', () => {
    frameScheduler();
    const { bus, graph } = mount();
    canvasOf(graph).dispatchEvent(ptr('pointerdown', xOf(4), yForDb(-6)));
    window.dispatchEvent(ptr('pointerup', xOf(4), yForDb(-6)));
    window.dispatchEvent(ptr('pointermove', xOf(0), yForDb(18)));
    expect(bus.get('fx.eq.b0')).toBe(0);
  });

  it('ignores a wheel — the page scrolls there', () => {
    frameScheduler();
    const { bus, graph } = mount();
    const before = EQ_BANDS.map((_, i) => bus.get(`fx.eq.b${i}`));
    canvasOf(graph).dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
    expect(EQ_BANDS.map((_, i) => bus.get(`fx.eq.b${i}`))).toEqual(before);
  });

  it('clamps a drag past the top of the plot to the param’s own range', () => {
    frameScheduler();
    const { bus, graph } = mount();
    canvasOf(graph).dispatchEvent(ptr('pointerdown', xOf(4), -500));
    expect(bus.get('fx.eq.b4')).toBe(bus.def('fx.eq.b4')!.max);
  });
});

describe('repainting (REQ-the-graph-computes-from-bus-values)', () => {
  it('coalesces a whole preset’s worth of writes into one frame', () => {
    const frames = frameScheduler();
    const { bus, graph } = mount();
    frames.run(); // drain the constructor's first paint
    graph.setVisible(true);
    frames.run();

    for (let i = 0; i < EQ_BAND_COUNT; i++) bus.set(`fx.eq.b${i}`, i - 4);
    bus.set('fx.eq.hp', 120);
    bus.set('fx.eq.lp', 9000);
    bus.set('fx.eq.width', 2);

    expect(frames.queued, 'twelve writes must not be twelve frames').toBe(1);
  });

  it('runs no loop of its own — a painted frame queues no successor', () => {
    const frames = frameScheduler();
    const { bus } = mount();
    frames.run();
    bus.set('fx.eq.b0', 3);
    expect(frames.queued).toBe(1);
    frames.run();
    expect(frames.queued, 'the graph is event-driven, not animated').toBe(0);
  });

  it('does not paint while hidden, and repaints once on reveal', () => {
    const frames = frameScheduler();
    const { bus, graph, painter } = mount();
    frames.run();

    graph.setVisible(false);
    painter.reset();
    bus.set('fx.eq.b5', -8);
    frames.run();
    expect(painter.drew(), 'a folded page must not paint').toBe(false);

    graph.setVisible(true);
    frames.run();
    expect(painter.drew(), 'and must be correct the instant it is revealed').toBe(true);
  });

  it('mirrors the curve for E2E, and only when it changes', () => {
    const frames = frameScheduler();
    const { bus, graph } = mount();
    frames.run();
    const flat = graph.el.dataset.eqCurve;
    expect(flat).toBeDefined();
    expect(flat!.split(',')).toHaveLength(EQ_BAND_COUNT);
    expect(Number(flat!.split(',')[0])).toBeCloseTo(0, 6);

    bus.set('fx.eq.b0', 12);
    frames.run();
    expect(graph.el.dataset.eqCurve).not.toBe(flat);
  });
});

describe('teardown (REQ-the-graph-computes-from-bus-values)', () => {
  it('releases its subscriptions, listeners and pending frame', () => {
    const frames = frameScheduler();
    const { bus, graph, painter } = mount();
    frames.run();

    bus.set('fx.eq.b1', -5); // arm a frame
    expect(frames.queued).toBe(1);

    graph.destroy();
    expect(frames.queued, 'a pending frame must be cancelled').toBe(0);

    painter.reset();
    bus.set('fx.eq.b2', -5);
    frames.run();
    expect(painter.drew()).toBe(false);

    // The drag listeners are gone too — a stray move must reach nothing.
    const before = bus.get('fx.eq.b0');
    window.dispatchEvent(ptr('pointermove', xOf(0), yForDb(-18)));
    expect(bus.get('fx.eq.b0')).toBe(before);
  });
});

describe('an in-flight frame respects a hide (REQ-the-graph-computes-from-bus-values, regression)', () => {
  it('does not paint a frame that was queued before the page folded away', () => {
    // `invalidate` guards the scheduling; the callback needs its own guard, or a
    // fold that lands between "frame queued" and "frame runs" still paints.
    const frames = frameScheduler();
    const { bus, graph, painter } = mount();
    frames.run();

    bus.set('fx.eq.b4', -7); // queues a frame while visible
    expect(frames.queued).toBe(1);
    graph.setVisible(false); // …and the page folds before it arrives
    painter.reset();
    frames.run();
    expect(painter.drew()).toBe(false);

    // The change is not lost: revealing repaints from the current values.
    graph.setVisible(true);
    frames.run();
    expect(painter.drew()).toBe(true);
  });
});
