// Number formatting, escaping and path geometry. Pure functions, no palette.

/** A coordinate as the SVG prints it: one decimal. */
export const n = (v) => +v.toFixed(1);

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A rough width for a run of text: the poster has no font metrics to ask. */
export const textW = (s, size) => s.length * size * 0.6;

/** A path through `steps + 1` samples of `f(t)`, t in [0, 1]. */
export function fpath(f, steps = 64) {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const [x, y] = f(i / steps);
    d += `${i ? 'L' : 'M'}${n(x)} ${n(y)}`;
  }
  return d;
}

/** A seeded Park–Miller generator: the same seed draws the same icon every run. */
export function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** A rounded orthogonal path through points. */
export function rpath(pts, r = 14) {
  let d = `M${n(pts[0][0])} ${n(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x1 + ((x0 - x1) / l1) * rr;
    const ay = y1 + ((y0 - y1) / l1) * rr;
    const bx = x1 + ((x2 - x1) / l2) * rr;
    const by = y1 + ((y2 - y1) / l2) * rr;
    d += ` L${n(ax)} ${n(ay)} Q${n(x1)} ${n(y1)} ${n(bx)} ${n(by)}`;
  }
  const [xe, ye] = pts[pts.length - 1];
  return `${d} L${n(xe)} ${n(ye)}`;
}

/** Drop consecutive duplicate points. */
export function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/** Move the first point d0 toward the second and the last d1 toward the one before. */
export function shorten(pts, d0, d1) {
  const p = pts.map((q) => [...q]);
  const mv = (a, b, d) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) return;
    const k = Math.min(d, l - 1) / l;
    a[0] += (b[0] - a[0]) * k;
    a[1] += (b[1] - a[1]) * k;
  };
  if (d0) mv(p[0], p[1], d0);
  if (d1) mv(p[p.length - 1], p[p.length - 2], d1);
  return p;
}

/** The midpoint of a polyline's longest segment — where its label goes. */
export function midOfLongest(pts) {
  let best = 0;
  let at = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (l > best) { best = l; at = [(pts[i][0] + pts[i - 1][0]) / 2, (pts[i][1] + pts[i - 1][1]) / 2]; }
  }
  return at;
}

/** The union of some boxes, padded. */
export function union(boxes, pad = 0) {
  const x0 = Math.min(...boxes.map((b) => b.x)) - pad;
  const y0 = Math.min(...boxes.map((b) => b.y)) - pad;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** `r` cut down to the part inside `p`. */
export function intersect(r, p) {
  const x0 = Math.max(r.x, p.x);
  const y0 = Math.max(r.y, p.y);
  return { x: x0, y: y0, w: Math.min(r.x + r.w, p.x + p.w) - x0, h: Math.min(r.y + r.h, p.y + p.h) - y0 };
}

/** Whether a point lies inside a box (edges included). */
export const contains = (z, x, y) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
