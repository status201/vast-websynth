/**
 * The signal-flow map's camera: pure view maths, no DOM (signal-flow-map.md).
 *
 * A `View` is the poster rectangle on screen — the SVG `viewBox` — always at the
 * stage's own aspect, so the poster is never letterboxed inside it and one
 * poster unit maps to `stage.w / view.w` screen px on both axes.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export type View = Rect;

export interface Size {
  readonly w: number;
  readonly h: number;
}

/** The closest a view may get: this many screen px per poster unit. */
export const MAX_PX_PER_UNIT = 3;

/** The overview's margin, as a fraction of the poster — also the furthest out a view may go. */
export const OVERVIEW_PAD = 0.015;

/** The view that shows `r` whole and centred on a stage of size `stage`, with a margin of `pad` × its size. */
export function fitRect(r: Rect, stage: Size, pad = 0.04): View {
  const aspect = stage.w / stage.h;
  let w = r.w * (1 + 2 * pad);
  let h = r.h * (1 + 2 * pad);
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

/**
 * Zoom by `factor` (> 1 is closer) about the poster point (`px`, `py`), which
 * stays where it is on screen.
 */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const w = v.w / factor;
  const h = v.h / factor;
  return { x: px - (px - v.x) / factor, y: py - (py - v.y) / factor, w, h };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { x: v.x + dx, y: v.y + dy, w: v.w, h: v.h };
}

/** `v` resized to a stage of a new aspect, keeping its centre and its scale. */
export function reshape(v: View, from: Size, to: Size): View {
  const unitsPerPx = v.w / from.w;
  const w = to.w * unitsPerPx;
  const h = to.h * unitsPerPx;
  return { x: v.x + v.w / 2 - w / 2, y: v.y + v.h / 2 - h / 2, w, h };
}

/**
 * Keep a view usable: no closer than `MAX_PX_PER_UNIT`, no further out than the
 * overview (`fitRect(bounds, stage, OVERVIEW_PAD)`), and its centre on the
 * poster, so some of it is always on screen.
 */
export function clampView(v: View, bounds: Rect, stage: Size): View {
  const widest = fitRect(bounds, stage, OVERVIEW_PAD).w;
  const narrowest = stage.w / MAX_PX_PER_UNIT;
  const w = Math.min(Math.max(v.w, Math.min(narrowest, widest)), widest);
  const h = (w * stage.h) / stage.w;
  const cx = Math.min(Math.max(v.x + v.w / 2, bounds.x), bounds.x + bounds.w);
  const cy = Math.min(Math.max(v.y + v.h / 2, bounds.y), bounds.y + bounds.h);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * The view `t` (0…1) of the way from `a` to `b`. The size moves geometrically,
 * so a long zoom feels even rather than rushing at the start; the centre moves
 * linearly.
 */
export function lerpView(a: View, b: View, t: number): View {
  const w = a.w * Math.pow(b.w / a.w, t);
  const h = a.h * Math.pow(b.h / a.h, t);
  const cx = a.x + a.w / 2 + (b.x + b.w / 2 - (a.x + a.w / 2)) * t;
  const cy = a.y + a.h / 2 + (b.y + b.h / 2 - (a.y + a.h / 2)) * t;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Ease-in-out (cubic). */
export function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
