import { describe, it, expect } from 'vitest';
import {
  clampView, ease, fitRect, lerpView, panBy, reshape, zoomAt, MAX_PX_PER_UNIT, OVERVIEW_PAD,
  type View,
} from '../../src/ui/signal-flow/camera';

/** signal-flow-map.md — the camera's maths (REQ-the-map-can-be-explored-freely). */
const POSTER = { x: 0, y: 0, w: 7300, h: 3760 };
const STAGE = { w: 1000, h: 600 };
const close = (a: View, b: View): void => {
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(a[k]).toBeCloseTo(b[k], 6);
};

describe('fitRect', () => {
  it('shows the rect whole, centred, at the stage aspect', () => {
    const r = { x: 100, y: 200, w: 400, h: 100 };
    const v = fitRect(r, STAGE, 0);
    expect(v.w / v.h).toBeCloseTo(STAGE.w / STAGE.h, 9);
    expect(v.x).toBeLessThanOrEqual(r.x);
    expect(v.y).toBeLessThanOrEqual(r.y);
    expect(v.x + v.w).toBeGreaterThanOrEqual(r.x + r.w);
    expect(v.y + v.h).toBeGreaterThanOrEqual(r.y + r.h);
    expect(v.x + v.w / 2).toBeCloseTo(300, 9);
    expect(v.y + v.h / 2).toBeCloseTo(250, 9);
    expect(v.w).toBeCloseTo(400, 9); // width-bound: a wide rect on a 5:3 stage
  });

  it('pads by a fraction of the rect', () => {
    expect(fitRect({ x: 0, y: 0, w: 1000, h: 100 }, STAGE, 0.1).w).toBeCloseTo(1200, 9);
  });
});

describe('zoomAt / panBy / reshape', () => {
  it('keeps the zoom point where it was on screen', () => {
    const v = { x: 0, y: 0, w: 1000, h: 600 };
    const z = zoomAt(v, 2, 250, 150);
    expect(z.w).toBe(500);
    // (250, 150) was a quarter of the way across; it still is.
    expect((250 - z.x) / z.w).toBeCloseTo(0.25, 9);
    expect((150 - z.y) / z.h).toBeCloseTo(0.25, 9);
  });

  it('pans by poster units', () => {
    expect(panBy({ x: 1, y: 2, w: 3, h: 4 }, 10, -2)).toEqual({ x: 11, y: 0, w: 3, h: 4 });
  });

  it('keeps centre and scale through a stage resize', () => {
    const v = { x: 100, y: 100, w: 1000, h: 600 };
    const r = reshape(v, STAGE, { w: 500, h: 600 });
    expect(r.w / 500).toBeCloseTo(v.w / STAGE.w, 9);
    expect(r.x + r.w / 2).toBeCloseTo(600, 9);
    expect(r.y + r.h / 2).toBeCloseTo(400, 9);
  });
});

describe('clampView', () => {
  it('zooms out no further than the overview', () => {
    const c = clampView({ x: 3650 - 20000, y: 1880 - 12000, w: 40000, h: 24000 }, POSTER, STAGE);
    close(c, fitRect(POSTER, STAGE, OVERVIEW_PAD));
  });

  it('zooms in no closer than MAX_PX_PER_UNIT', () => {
    const c = clampView({ x: 100, y: 100, w: 10, h: 6 }, POSTER, STAGE);
    expect(STAGE.w / c.w).toBeCloseTo(MAX_PX_PER_UNIT, 9);
  });

  it('keeps the centre on the poster', () => {
    const c = clampView({ x: 9000, y: -2000, w: 1000, h: 600 }, POSTER, STAGE);
    expect(c.x + c.w / 2).toBe(POSTER.w);
    expect(c.y + c.h / 2).toBe(0);
  });

  it('leaves a view inside the limits alone', () => {
    const v = { x: 1000, y: 1000, w: 1000, h: 600 };
    close(clampView(v, POSTER, STAGE), v);
  });
});

describe('lerpView / ease', () => {
  const a = { x: 0, y: 0, w: 1000, h: 600 };
  const b = { x: 500, y: 300, w: 100, h: 60 };

  it('starts at a and ends at b', () => {
    close(lerpView(a, b, 0), a);
    close(lerpView(a, b, 1), b);
  });

  it('moves the size geometrically', () => {
    expect(lerpView(a, b, 0.5).w).toBeCloseTo(Math.sqrt(1000 * 100), 9);
  });

  it('eases from 0 to 1 through ½', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 9);
  });
});
