// Glyph outlines from a static TrueType font, as SVG path data. Zero deps.
//
// Enough of the format for turning a line of text into paths: the table
// directory, `head`, `cmap` (format 4, the Windows BMP subtable), `loca` and
// `glyf` (simple and composite glyphs). Layout — advances, kerning, any
// letter-spacing — is the caller's: pass each glyph's origin. No variable
// fonts (no `gvar`) and no CFF/OpenType-PostScript outlines; both throw.

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POS = 0x10;
const Y_SAME_OR_POS = 0x20;

const ARGS_ARE_WORDS = 0x0001;
const ARGS_ARE_XY = 0x0002;
const HAS_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAS_XY_SCALE = 0x0040;
const HAS_2X2 = 0x0080;

/** Parse a TrueType font from its bytes. */
export function loadTtf(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  const numTables = v.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(v.getUint8(rec), v.getUint8(rec + 1), v.getUint8(rec + 2), v.getUint8(rec + 3));
    tables.set(tag, v.getUint32(rec + 8));
  }
  const need = (tag) => {
    const at = tables.get(tag);
    if (at === undefined) throw new Error(`ttf: no '${tag}' table`);
    return at;
  };
  if (tables.has('gvar')) throw new Error('ttf: variable fonts are not supported');
  if (!tables.has('glyf')) throw new Error('ttf: no TrueType outlines (CFF font?)');

  const head = need('head');
  const unitsPerEm = v.getUint16(head + 18);
  const longLoca = v.getInt16(head + 50) === 1;
  const numGlyphs = v.getUint16(need('maxp') + 4);
  const loca = need('loca');
  const glyf = need('glyf');
  const glyphOffset = (gid) =>
    longLoca ? v.getUint32(loca + gid * 4) : v.getUint16(loca + gid * 2) * 2;

  const cmap = cmapLookup(v, need('cmap'));

  /** Contours of glyph `gid` in font units: arrays of { x, y, on }. */
  function contours(gid, depth = 0) {
    if (depth > 8) throw new Error('ttf: composite glyphs nest too deep');
    if (gid >= numGlyphs) throw new Error(`ttf: glyph ${gid} out of range`);
    const start = glyphOffset(gid);
    if (glyphOffset(gid + 1) === start) return []; // an empty glyph (a space)
    const at = glyf + start;
    const n = v.getInt16(at);
    return n >= 0 ? simpleContours(v, at, n) : compositeContours(at, depth);
  }

  function compositeContours(at, depth) {
    const out = [];
    let p = at + 10;
    let flags;
    do {
      flags = v.getUint16(p);
      const child = v.getUint16(p + 2);
      p += 4;
      if (!(flags & ARGS_ARE_XY)) throw new Error('ttf: point-matched components are not supported');
      let dx, dy;
      if (flags & ARGS_ARE_WORDS) { dx = v.getInt16(p); dy = v.getInt16(p + 2); p += 4; }
      else { dx = v.getInt8(p); dy = v.getInt8(p + 1); p += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      const f2dot14 = (o) => v.getInt16(o) / 16384;
      if (flags & HAS_SCALE) { a = d = f2dot14(p); p += 2; }
      else if (flags & HAS_XY_SCALE) { a = f2dot14(p); d = f2dot14(p + 2); p += 4; }
      else if (flags & HAS_2X2) { a = f2dot14(p); b = f2dot14(p + 2); c = f2dot14(p + 4); d = f2dot14(p + 6); p += 8; }
      for (const contour of contours(child, depth + 1)) {
        out.push(contour.map(({ x, y, on }) => ({ x: a * x + c * y + dx, y: b * x + d * y + dy, on })));
      }
    } while (flags & MORE_COMPONENTS);
    return out;
  }

  return {
    unitsPerEm,
    /** The glyph id for one character; throws when the font lacks it. */
    glyphOf(char) {
      const gid = cmap(char.codePointAt(0));
      if (!gid) throw new Error(`ttf: no glyph for '${char}'`);
      return gid;
    },
    /**
     * SVG path data for glyph `gid` with its origin (the baseline's left end) at
     * (x, y) in SVG user space, `size` user units per em. Font y runs up, SVG's down.
     */
    glyphPath(gid, x, y, size) {
      const k = size / unitsPerEm;
      const pt = (q) => `${fmt(x + q.x * k)} ${fmt(y - q.y * k)}`;
      return contours(gid).map((c) => contourPath(c, pt)).join('');
    },
  };
}

/** A `cmap` format 4 lookup (platform 3, encoding 1 — or 0, the symbol encoding). */
function cmapLookup(v, cmap) {
  const n = v.getUint16(cmap + 2);
  let sub = -1;
  for (let i = 0; i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = v.getUint16(rec);
    const encoding = v.getUint16(rec + 2);
    const at = cmap + v.getUint32(rec + 4);
    if (platform === 3 && (encoding === 1 || encoding === 0) && v.getUint16(at) === 4) { sub = at; break; }
  }
  if (sub < 0) throw new Error('ttf: no format-4 Windows cmap');
  const segX2 = v.getUint16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  return (code) => {
    for (let s = 0; s < segX2; s += 2) {
      if (code > v.getUint16(ends + s)) continue;
      const first = v.getUint16(starts + s);
      if (code < first) return 0;
      const delta = v.getInt16(deltas + s);
      const range = v.getUint16(ranges + s);
      if (range === 0) return (code + delta) & 0xffff;
      const g = v.getUint16(ranges + s + range + (code - first) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
}

function simpleContours(v, at, n) {
  const endPts = [];
  for (let i = 0; i < n; i++) endPts.push(v.getUint16(at + 10 + i * 2));
  const count = n ? endPts[n - 1] + 1 : 0;
  let p = at + 10 + n * 2;
  p += 2 + v.getUint16(p); // skip the instructions

  const flags = [];
  while (flags.length < count) {
    const f = v.getUint8(p++);
    flags.push(f);
    if (f & REPEAT) for (let r = v.getUint8(p++); r > 0; r--) flags.push(f);
  }
  const coords = (short, sameOrPos) => {
    const out = [];
    let c = 0;
    for (const f of flags) {
      if (f & short) { const d = v.getUint8(p++); c += f & sameOrPos ? d : -d; }
      else if (!(f & sameOrPos)) { c += v.getInt16(p); p += 2; }
      out.push(c);
    }
    return out;
  };
  const xs = coords(X_SHORT, X_SAME_OR_POS);
  const ys = coords(Y_SHORT, Y_SAME_OR_POS);

  const out = [];
  let first = 0;
  for (const last of endPts) {
    const c = [];
    for (let i = first; i <= last; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & ON_CURVE) !== 0 });
    out.push(c);
    first = last + 1;
  }
  return out;
}

/** One closed contour as M/L/Q/Z, filling in the implied on-curve midpoints. */
function contourPath(c, pt) {
  if (c.length === 0) return '';
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
  // Start on an on-curve point: the first one, else the midpoint of the first two.
  let s = c.findIndex((q) => q.on);
  const pts = s >= 0 ? [...c.slice(s), ...c.slice(0, s)] : [mid(c[0], c[1]), ...c.slice(1), c[0]];
  let d = `M${pt(pts[0])}`;
  let ctrl = null;
  for (let i = 1; i <= pts.length; i++) {
    const q = pts[i % pts.length];
    if (q.on) {
      d += ctrl ? `Q${pt(ctrl)} ${pt(q)}` : `L${pt(q)}`;
      ctrl = null;
    } else if (ctrl) {
      const m = mid(ctrl, q);
      d += `Q${pt(ctrl)} ${pt(m)}`;
      ctrl = q;
    } else {
      ctrl = q;
    }
  }
  return d + 'Z';
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();
