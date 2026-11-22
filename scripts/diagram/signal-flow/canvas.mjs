// The drawing kit for one palette: the poster's layers, its block registry and
// zones, and every primitive the layout draws with (blocks, wires, labels, sums,
// regions, cards). Nothing here knows where anything goes — that is layout.mjs.
//
// Layers, bottom to top: regions · blocks · wires · labels (`over`) · header ·
// legend. Within a layer, elements stack in the order they were drawn.

import { HEAD, LINE, MONO, TEXT_STYLES, WIRE_TYPES } from './theme.mjs';
import { dedupe, esc, midOfLongest, n, rpath, shorten, textW } from './geometry.mjs';
import { createZones } from './zones.mjs';

// A block's ports: a point on its edge, by default the edge's midpoint, else
// `d` along it from the block's top / left corner.
export const R = (b, dy) => [b.x + b.w, dy === undefined ? b.y + b.h / 2 : b.y + dy];
export const Lf = (b, dy) => [b.x, dy === undefined ? b.y + b.h / 2 : b.y + dy];
export const T = (b, dx) => [dx === undefined ? b.x + b.w / 2 : b.x + dx, b.y];
export const Bt = (b, dx) => [dx === undefined ? b.x + b.w / 2 : b.x + dx, b.y + b.h];
/** Vertical centre of a box. */
export const oy = (b) => b.y + b.h / 2;
/** Centre y of body line i (0-based). */
export const lineY = (b, i) => b.y + HEAD + (b.iconH ? b.iconH + 18 : 10) + i * LINE + 13 - 5;
/** The right-edge port level with body line i — where a block's line "sends". */
export const Rl = (b, i) => [b.x + b.w, lineY(b, i)];

export function createCanvas(P) {
  const L = { regions: [], blocks: [], wires: [], over: [], header: [], legend: [] };
  const B = {};
  const zones = createZones(B);
  const { zone } = zones;

  // A TEXT_STYLES entry as presentation attributes in this palette.
  function st(name) {
    const t = TEXT_STYLES[name];
    if (!t) throw new Error(`unknown text style "${name}"`);
    let a = '';
    if (t.mono) a += ` font-family="${MONO}"`;
    if (t.it) a += ' font-style="italic"';
    if (t.w) a += ` font-weight="${t.w}"`;
    if (t.s) a += ` font-size="${t.s}"`;
    if (t.ls) a += ` letter-spacing="${t.ls}"`;
    if (t.f) a += ` fill="${P[t.f]}"`;
    if (t.stroke) a += ` stroke="${P[t.stroke]}" stroke-width="${t.sw}"`;
    return a.slice(1);
  }

  // ── blocks ──
  // Register a block; its height follows its content unless `o.h` is given.
  // Blocks are drawn last, all at once (drawBlocks), so the layout can still
  // read and position against every registered box.
  function mk(id, o) {
    const iconH = o.icon ? (o.iconH ?? 40) : 0;
    const pills = o.pills?.length ?? 0;
    const h = o.h ?? HEAD + (iconH ? iconH + 18 : 10) + (o.lines?.length ?? 0) * LINE + pills * 28 + 12;
    const b = { ...o, h, iconH };
    B[id] = b;
    return b;
  }

  /** Blocks stacked down a column, `gap` apart; returns the y below the last. */
  function stack(x, y, w, gap, list) {
    let yy = y;
    for (const [id, o] of list) {
      const b = mk(id, { x, y: yy, w, ...o });
      yy += b.h + gap;
    }
    return yy;
  }

  /** Every registered box that is a drawn block (tiles and frames are not). */
  const drawnBlocks = () => Object.entries(B).filter(([, b]) => b.cat && b.title !== undefined);

  function useIcon(id, x, y, w, h, color) {
    return `<use href="#sf-i-${id}" xlink:href="#sf-i-${id}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" color="${color}"/>`;
  }

  function pill(x, y, letter, label, type, anchor = 'start') {
    const c = P.wire[type];
    const fs = 12.5;
    const wTxt = label.length * fs * 0.66;
    const w = (letter ? 26 : 10) + wTxt + 12;
    const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    let s = `<g><rect x="${n(x0)}" y="${n(y - 11)}" width="${n(w)}" height="22" rx="11" fill="${P.panel}" stroke="${c}" stroke-width="1.8"/>`;
    if (letter) {
      s += `<circle cx="${n(x0 + 12)}" cy="${n(y)}" r="8.5" fill="${c}"/>`;
      s += `<text x="${n(x0 + 12)}" y="${n(y + 4.2)}" ${st('pl-l')} text-anchor="middle">${esc(letter)}</text>`;
    }
    s += `<text x="${n(x0 + (letter ? 26 : 10))}" y="${n(y + 4.4)}" ${st('pl')} fill="${c}">${esc(label)}</text></g>`;
    return { svg: s, x0, x1: x0 + w, w };
  }

  function drawBlock(b) {
    const c = P.cat[b.cat];
    const { x, y, w, h } = b;
    const r = 9;
    let s = `<g>`;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ${st('blk')}/>`;
    s += `<path d="M${x} ${y + HEAD} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + HEAD} Z" fill="${c}" fill-opacity="${P.headOp}"/>`;
    s += `<path d="M${x + 1} ${y + HEAD} H${x + w - 1}" stroke="${c}" stroke-width="1.6"/>`;
    s += edgeStrip(x, y, 5, HEAD, r, c);
    s += `<text x="${x + 14}" y="${y + 23}" ${st('bt')}>${esc(b.title)}</text>`;
    if (b.tag) s += `<text x="${x + w - 10}" y="${y + 22}" ${st('btag')} text-anchor="end" fill="${c}">${esc(b.tag)}</text>`;
    let cy = y + HEAD + 10;
    if (b.icon) {
      const iw = b.iconW ?? 66;
      const ix = b.iconAlign === 'left' ? x + 14 : x + (w - iw) / 2;
      s += useIcon(b.icon, ix, cy + 2, iw, b.iconH, c);
      cy += b.iconH + 8;
    }
    // A line starting ** is bold, one starting ~ is a faint aside.
    for (const raw of b.lines ?? []) {
      cy += LINE;
      let cls = 'bl';
      let t = raw;
      if (t.startsWith('**')) { cls = 'blb'; t = t.slice(2); }
      else if (t.startsWith('~')) { cls = 'blf'; t = t.slice(1); }
      s += `<text x="${x + 14}" y="${cy - 4}" ${st(cls)}>${esc(t)}</text>`;
    }
    for (const p of b.pills ?? []) {
      cy += 28;
      s += pill(x + 14, cy - 12, p[0], p[1], p[2]).svg;
    }
    for (const m of b.marks ?? []) {
      s += `<text x="${x + 14}" y="${m.y + 4.5}" ${st('mk')}>${esc(m.t)}</text>`;
    }
    if (b.badge) s += badge(x + w - 8, y + h - 8, b.badge, 'end-bottom');
    s += `</g>`;
    L.blocks.push(s);
  }

  function drawBlocks() {
    for (const [, b] of drawnBlocks()) drawBlock(b);
  }

  // The section colour strip down a block's left edge, `w` wide, clipped to the
  // block's corner radius `r` (> w) at the top — and at the bottom too when it
  // runs the block's full height. Each corner is the matching piece of the
  // block's own quadratic corner, so the two outlines coincide.
  function edgeStrip(x, y, w, h, r, fill, roundBottom = false) {
    const t = Math.sqrt(w / r); // where the corner's curve reaches x + w
    const c = r * (1 - t); // that piece's control point, below the corner
    const a = r * (1 - t) ** 2; // how far below the corner the curve meets x + w
    let d = `M${x} ${n(y + r)} Q${x} ${n(y + c)} ${x + w} ${n(y + a)}`;
    d += roundBottom ? ` V${n(y + h - a)} Q${x} ${n(y + h - c)} ${x} ${n(y + h - r)}` : ` V${y + h} H${x}`;
    return `<path d="${d} Z" fill="${fill}"/>`;
  }

  function badge(x, y, label, pos = 'middle') {
    const fs = 11;
    const w = textW(label, fs) * 0.95 + 16;
    let x0 = x - w / 2;
    let y0 = y - 9;
    if (pos === 'end-bottom') { x0 = x - w; y0 = y - 18; }
    const c = P.wire.stereo;
    return `<g><rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="18" rx="9" fill="${c}"/>`
      + `<text x="${n(x0 + w / 2)}" y="${n(y0 + 13)}" ${st('bdg')} text-anchor="middle">${esc(label)}</text></g>`;
  }

  // ── wires ──
  // o.arrow false → no arrowhead · o.from 'bus' → starts on a bus (dot, no gap)
  // · o.dot1 → a junction dot at the far end · o.h0 / o.h1 → the gap left
  // at each end · o.label (+ o.at, o.anchor) → a label, by default mid-way
  // along the longest run.
  function wire(type, pts, o = {}) {
    pts = dedupe(pts);
    const wt = WIRE_TYPES[type];
    const c = P.wire[type];
    const h0 = o.h0 ?? (o.from === 'bus' ? 14 : 4);
    const h1 = o.h1 ?? (o.arrow === false ? 14 : 8);
    // A halo in the paper colour, so a wire reads over whatever it crosses.
    let s = `<path d="${rpath(shorten(pts, h0, h1))}" fill="none" stroke="${P.bg}" stroke-width="${wt.w + 8}" stroke-linecap="butt" stroke-linejoin="round"/>`;
    const dash = wt.dash ? ` stroke-dasharray="${wt.dash}"` : '';
    const cap = type === 'clock' ? 'round' : 'butt';
    const marker = o.arrow === false ? '' : ` marker-end="url(#sf-m-${type})"`;
    if (type === 'stereo') {
      // Two lines: a wide stroke with a paper-coloured core.
      s += `<path d="${rpath(pts)}" fill="none" stroke="${c}" stroke-width="${wt.w}" stroke-linejoin="round"${marker}/>`;
      s += `<path d="${rpath(shorten(pts, 0, o.arrow === false ? 0 : 16))}" fill="none" stroke="${P.bg}" stroke-width="3" stroke-linejoin="round"/>`;
    } else {
      s += `<path d="${rpath(pts)}" fill="none" stroke="${c}" stroke-width="${wt.w}" stroke-linecap="${cap}" stroke-linejoin="round"${dash}${marker}/>`;
    }
    const dotR = type === 'stereo' ? 7 : 5;
    if (o.from === 'bus') s += `<circle cx="${n(pts[0][0])}" cy="${n(pts[0][1])}" r="${dotR}" fill="${c}"/>`;
    if (o.dot1) s += `<circle cx="${n(pts.at(-1)[0])}" cy="${n(pts.at(-1)[1])}" r="${dotR}" fill="${c}"/>`;
    L.wires.push(s);
    if (o.label) {
      const [lx, ly] = o.at ?? midOfLongest(pts);
      label(lx, ly, o.label, type, o.anchor ?? 'middle');
    }
  }

  function label(x, y, t, type, anchor = 'middle') {
    const c = P.wire[type];
    const fs = 12;
    const w = textW(t, fs) * 0.9 + 14;
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    L.over.push(`<g><rect x="${n(x0)}" y="${n(y - 10)}" width="${n(w)}" height="20" rx="4" fill="${P.bg}" fill-opacity="0.92"/>`
      + `<text x="${n(x0 + w / 2)}" y="${n(y + 4.2)}" ${st('wl')} text-anchor="middle" fill="${c}">${esc(t)}</text></g>`);
  }

  function note(x, y, t, cls = 'nt', anchor = 'start') {
    L.over.push(`<text x="${n(x)}" y="${n(y)}" ${st(cls)} text-anchor="${anchor}">${esc(t)}</text>`);
  }

  /** A Σ (adds) or × (multiplies) node, with optional caption lines under it. */
  function sum(x, y, r, sym, c, under = []) {
    let s = `<circle cx="${x}" cy="${y}" r="${r}" fill="${P.panel}" stroke="${c}" stroke-width="2.6"/>`;
    if (sym === 'Σ') s += `<text x="${x}" y="${y + r * 0.36}" text-anchor="middle" ${st('sig')} font-size="${n(r * 1.05)}" fill="${c}">Σ</text>`;
    if (sym === '×') {
      const k = r * 0.48;
      s += `<path d="M${x - k} ${y - k} L${x + k} ${y + k} M${x + k} ${y - k} L${x - k} ${y + k}" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`;
    }
    under.forEach((t, i) => { s += `<text x="${x}" y="${y + r + 18 + i * 16}" text-anchor="middle" ${st(i ? 'sn2' : 'sn')}>${esc(t)}</text>`; });
    L.blocks.push(`<g>${s}</g>`);
  }

  // ── regions ──
  // A numbered top-level region; `zoneId` makes the box a map zone.
  function region(x, y, w, h, num, title, sub, zoneId) {
    // The box itself, not its numbered heading above: an outline up there would
    // cross the header, and its label would cover the heading it duplicates.
    if (zoneId) zone(zoneId, null, { x, y, w, h });
    L.regions.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${P.region}" stroke="${P.regionEdge}" stroke-width="2"/>`);
    if (title) {
      L.regions.push(`<g><circle cx="${x + 20}" cy="${y - 26}" r="17" fill="${P.heading}"/><text x="${x + 20}" y="${y - 20}" text-anchor="middle" ${st('rn')}>${num}</text>`
        + `<text x="${x + 46}" y="${y - 17}" ${st('rt')}>${esc(title)}</text>${sub ? `<text x="${x + 66 + title.length * 21}" y="${y - 18}" ${st('rs')}>${esc(sub)}</text>` : ''}</g>`);
    }
  }

  // A dashed band inside a region, titled up its left edge.
  function band(x, y, w, h, title, c, zoneId, parent) {
    if (zoneId) zone(zoneId, parent, { x, y, w, h });
    L.regions.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${P.band}" stroke="${c}" stroke-opacity="0.45" stroke-width="1.6" stroke-dasharray="8 6"/>`);
    L.regions.push(`<text transform="translate(${x + 26} ${y + h / 2}) rotate(-90)" text-anchor="middle" ${st('bandt')} fill="${c}">${esc(title)}</text>`);
  }

  // A dashed frame around things that repeat (per voice, per track).
  function frame(r, c, sw, dash, rx) {
    L.regions.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rx}" fill="${P.panel}" fill-opacity="0.35" stroke="${c}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`);
  }

  /** A text card; returns its rectangle (height from the row count). Rows starting ** are bold. */
  function card(r, title, rows, cat) {
    const { x, y, w } = r;
    const h = 54 + rows.length * 24 + 10;
    const c = P.cat[cat];
    let s = `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${P.panel}" stroke="${c}" stroke-width="1.6"/>`;
    s += `<text x="${x + 20}" y="${y + 34}" ${st('ct')} fill="${c}">${esc(title)}</text>`;
    rows.forEach((row, i) => {
      const bold = row.startsWith('**');
      s += `<text x="${x + 20}" y="${y + 64 + i * 24}" ${st(bold ? 'cb' : 'cl')}>${esc(bold ? row.slice(2) : row)}</text>`;
    });
    L.blocks.push(`${s}</g>`);
    return { ...r, h };
  }

  /** A legend sample of a wire type, with its name. */
  function keySample(x, y, t) {
    const wt = WIRE_TYPES[t];
    const c = P.wire[t];
    const dash = wt.dash ? ` stroke-dasharray="${wt.dash}"` : '';
    let s = `<path d="M${x} ${y} H${x + 120}" stroke="${c}" stroke-width="${wt.w}"${dash} stroke-linecap="${t === 'clock' ? 'round' : 'butt'}" marker-end="url(#sf-m-${t})"/>`;
    if (t === 'stereo') s += `<path d="M${x} ${y} H${x + 104}" stroke="${P.bg}" stroke-width="3"/>`;
    s += `<text x="${x + 140}" y="${y + 5}" ${st('kt')}>${esc(wt.name)}</text>`;
    return s;
  }

  /** One arrowhead marker per wire type. */
  function markers() {
    return Object.keys(WIRE_TYPES).map((t) => {
      const c = P.wire[t];
      const big = t === 'stereo' ? 1.5 : t === 'audio' || t === 'buf' ? 1.2 : 1;
      const w = n(14 * big);
      const h = n(11 * big);
      const fill = t === 'buf' ? `fill="${P.panel}" stroke="${c}" stroke-width="2"` : `fill="${c}"`;
      return `<marker id="sf-m-${t}" viewBox="0 0 ${w} ${h}" refX="${w - 1}" refY="${h / 2}" markerWidth="${w}" markerHeight="${h}" markerUnits="userSpaceOnUse" orient="auto"><path d="M1 1 L${w - 1} ${h / 2} L1 ${h - 1} Z" ${fill}/></marker>`;
    }).join('');
  }

  return {
    P, L, B, zones, st,
    mk, stack, drawnBlocks, drawBlocks, useIcon, pill, edgeStrip, badge,
    wire, label, note, sum, region, band, frame, card, keySample, markers,
  };
}
