import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScratchGraph, rateLabel } from '../../src/ui/components/scratch-graph';
import type { ScratchCurve } from '../../src/audio/recorder/scratch-curve';

const W = 400;
const RECT = {
  left: 0, top: 0, width: W, height: 210, right: W, bottom: 210, x: 0, y: 0, toJSON() {},
};

/* Lane geometry, mirrored from the component. A y here is a claim about which
 * lane a tap lands in, so it has to be spelled out rather than derived. */
const Y_CUT = 6;
const Y_PREVIEW = 40;
const Y_RATE_ZERO = 122;      // rate 0 — the centre of the rate lane
const Y_RATE_UNITY = 107.5;   // rate 1 (the lane spans the model’s full +/-4)
const Y_SOURCE = 190;

function curve(rows: Array<[number, number]>, steps = 16): ScratchCurve {
  return {
    steps,
    cue: 0,
    points: rows.map(([t, v]) => ({ t, v, cut: false, hold: false })),
  };
}

function down(el: HTMLElement, x: number, y: number, shiftKey = false): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, shiftKey }));
}
function move(el: HTMLElement, x: number, y: number, shiftKey = false): void {
  el.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, shiftKey }));
}
function up(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('pointerup', {}));
}

describe('ScratchGraph', () => {
  const built: ScratchGraph[] = [];
  let latest: ScratchCurve | null = null;
  let commits = 0;
  let auditions = 0;

  function mount(initial: ScratchCurve): { g: ScratchGraph; canvas: HTMLElement } {
    const g = new ScratchGraph({
      curve: initial,
      onChange: (c) => { latest = c; },
      onCommit: () => { commits++; },
      onAudition: () => { auditions++; },
    });
    built.push(g);
    document.body.appendChild(g.el);
    const canvas = g.el.querySelector('[data-testid="scratch-canvas"]') as HTMLElement;
    // jsdom has no layout: the rect and the width both have to be supplied, or
    // every coordinate collapses to zero and the gestures test nothing.
    canvas.getBoundingClientRect = () => RECT as DOMRect;
    Object.defineProperty(canvas, 'clientWidth', { value: W, configurable: true });
    return { g, canvas };
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    // jsdom ships no 2D context and logs a "Not implemented" line for every
    // call. Stubbing it says what these tests actually assert — that the
    // gestures and the model are right with nothing painted at all — and keeps
    // a real failure from scrolling past behind the noise.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    latest = null;
    commits = 0;
    auditions = 0;
  });
  afterEach(() => {
    built.forEach((g) => g.destroy());
    built.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('mounts a canvas and a legend under stable testids', () => {
    const { g } = mount(curve([[0, 1]]));
    expect(g.el.dataset.testid).toBe('scratch-graph');
    expect(g.el.querySelector('[data-testid="scratch-canvas"]')).not.toBeNull();
    expect(g.el.querySelector('[data-testid="scratch-legend"]')).not.toBeNull();
  });

  it('adds a point where the rate lane is tapped', () => {
    const { canvas } = mount(curve([[0, 1]]));
    down(canvas, W / 2, Y_RATE_UNITY);
    up(canvas);
    expect(latest!.points.length).toBe(2);
    expect(latest!.points[1]!.t).toBeCloseTo(0.5, 6);
    expect(latest!.points[1]!.v).toBeCloseTo(1, 1);
  });

  it('snaps a horizontal drag to the 32nd grid', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 1]]));
    down(canvas, W / 2, Y_RATE_UNITY);          // grabs the existing point
    move(canvas, 213, Y_RATE_ZERO);
    up(canvas);
    // 213/400 = 0.5325 -> nearest 1/32 is 17/32.
    expect(latest!.points[1]!.t).toBeCloseTo(17 / 32, 6);
  });

  it('drags off the grid while Shift is held', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 1]]));
    down(canvas, W / 2, Y_RATE_UNITY);
    move(canvas, 213, Y_RATE_ZERO, true);
    up(canvas);
    expect(latest!.points[1]!.t).toBeCloseTo(0.5325, 6);
  });

  it('maps vertical position to playback rate', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 1]]));
    down(canvas, W / 2, Y_RATE_UNITY);
    move(canvas, W / 2, Y_RATE_ZERO);
    up(canvas);
    expect(latest!.points[1]!.v).toBeCloseTo(0, 6);
  });

  it('snaps the rate to quarters so unity is reachable by eye', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 1]]));
    down(canvas, W / 2, Y_RATE_UNITY);
    move(canvas, W / 2, 122 - (0.9 / 4) * 58);    // aiming just under 1x
    up(canvas);
    expect(latest!.points[1]!.v).toBeCloseTo(1, 6);
  });

  it('lets Shift off the rate steps as well as off the time grid', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 1]]));
    down(canvas, W / 2, Y_RATE_UNITY);
    move(canvas, W / 2, 122 - (0.9 / 4) * 58, true);
    up(canvas);
    expect(latest!.points[1]!.v).toBeCloseTo(0.9, 6);
  });

  it('keeps the opening point pinned to the start of the scratch', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 1]]));
    down(canvas, 0, Y_RATE_UNITY);              // grabs point 0
    move(canvas, 300, Y_RATE_ZERO);
    up(canvas);
    expect(latest!.points[0]!.t).toBe(0);
    expect(latest!.points[0]!.v).toBeCloseTo(0, 6);
  });

  it('deletes a point on a double-tap', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 2]]));
    const y = 122 - (2 / 4) * 58;               // rate 2
    down(canvas, W / 2, y);
    up(canvas);
    down(canvas, W / 2, y);
    up(canvas);
    expect(latest!.points.length).toBe(1);
  });

  it('does not delete the last point a curve has', () => {
    const { canvas } = mount(curve([[0, 1]]));
    down(canvas, 0, Y_RATE_UNITY);
    up(canvas);
    down(canvas, 0, Y_RATE_UNITY);
    up(canvas);
    expect(latest === null ? 1 : latest.points.length).toBe(1);
  });

  it('treats two slow taps as two separate gestures, not a delete', () => {
    vi.useFakeTimers();
    const { canvas } = mount(curve([[0, 1], [0.5, 2]]));
    const y = 122 - (2 / 4) * 58;
    down(canvas, W / 2, y);
    up(canvas);
    vi.advanceTimersByTime(600);
    down(canvas, W / 2, y);
    up(canvas);
    expect(latest === null ? 2 : latest.points.length).toBe(2);
  });

  it('toggles a segment cut from the band above it', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 1]]));
    down(canvas, W * 0.75, Y_CUT);
    expect(latest!.points[1]!.cut).toBe(true);
    down(canvas, W * 0.75, Y_CUT);
    expect(latest!.points[1]!.cut).toBe(false);
  });

  it('auditions when the preview lane is tapped, and edits nothing', () => {
    const { canvas } = mount(curve([[0, 1]]));
    down(canvas, W / 2, Y_PREVIEW);
    expect(auditions).toBe(1);
    expect(latest).toBeNull();
  });

  it('moves the cue by dragging the source lane', () => {
    const { canvas } = mount(curve([[0, 1]]));
    down(canvas, W / 4, Y_SOURCE);
    expect(latest!.cue).toBeCloseTo(0.25, 6);
    move(canvas, W * 0.75, Y_SOURCE);
    expect(latest!.cue).toBeCloseTo(0.75, 6);
    up(canvas);
  });

  it('reports a finished gesture once, for the audition hook', () => {
    const { canvas } = mount(curve([[0, 1], [0.5, 1]]));
    commits = 0;
    down(canvas, W / 2, Y_RATE_UNITY);
    move(canvas, 250, Y_RATE_ZERO);
    up(canvas);
    expect(commits).toBeGreaterThan(0);
  });

  it('accepts a curve pushed in from outside', () => {
    const { g } = mount(curve([[0, 1]]));
    g.setCurve(curve([[0, 1], [0.25, -2], [0.5, 2]]));
    g.setSource(new Float32Array(64), 1000);
    g.setGrid(8, 16, 2000);
    expect(g.el.querySelector('[data-testid="scratch-legend"]')!.innerHTML)
      .toContain('3');
  });

  it('stops listening once destroyed', () => {
    const { g, canvas } = mount(curve([[0, 1]]));
    g.destroy();
    down(canvas, W / 2, Y_RATE_UNITY);
    up(canvas);
    expect(latest).toBeNull();
  });

  it('survives a degenerate rect instead of dividing by it', () => {
    const g = new ScratchGraph({ curve: curve([[0, 1]]), onChange: (c) => { latest = c; } });
    built.push(g);
    document.body.appendChild(g.el);
    const canvas = g.el.querySelector('[data-testid="scratch-canvas"]') as HTMLElement;
    expect(() => { down(canvas, 10, Y_RATE_UNITY); up(canvas); }).not.toThrow();
    if (latest) for (const p of latest.points) expect(Number.isFinite(p.t)).toBe(true);
  });
});

describe('rateLabel', () => {
  it('reads a rate as a pitch a musician can act on', () => {
    expect(rateLabel(1)).toContain('+0.0 st');
    expect(rateLabel(2)).toContain('+12.0 st');
    expect(rateLabel(0.5)).toContain('-12.0 st');
  });

  it('names the two states that are not a pitch', () => {
    expect(rateLabel(0)).toBe('stopped');
    expect(rateLabel(-1)).toContain('←');
  });
});
