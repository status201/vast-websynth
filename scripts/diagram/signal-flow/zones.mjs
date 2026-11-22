// The in-app map's zones and spots (specs/features/signal-flow-map.md): the copy
// from zone-copy.mjs plus a box from the layout. A child zone is clipped to its
// parent; a spot is every drawn block, homed in the smallest leaf zone that
// holds its centre.

import { ZONE_TEXT, TOUR_ORDER } from './zone-copy.mjs';
import { contains, intersect, n, union } from './geometry.mjs';

/** A zone registry over a block registry `B` (layout id → box). */
export function createZones(B) {
  const list = [];

  function zone(id, parent, r) {
    const t = ZONE_TEXT[id];
    if (!t) throw new Error(`no ZONE_TEXT for zone "${id}"`);
    if (parent) {
      const p = list.find((z) => z.id === parent);
      if (!p) throw new Error('a zone parent must be registered before its children');
      r = intersect(r, p); // a child never pokes out of its parent
    }
    list.push({ id, ...(parent ? { parent } : {}), title: t[0], blurb: t[1], x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) });
  }

  /** The union of some boxes — block ids or {x, y, w, h} — padded. */
  const around = (items, pad = 12) => union(items.map((it) => (typeof it === 'string' ? B[it] : it)), pad);

  function checkTour() {
    for (const id of TOUR_ORDER) {
      if (!list.some((z) => z.id === id)) throw new Error(`tour stop "${id}" is not a zone`);
    }
  }

  // What a help topic's deep link rings on the map (signal-flow-map.md
  // REQ-a-help-topic-shows-its-place). Taken from the blocks, never listed by hand.
  function spots(drawn) {
    const isLeaf = (z) => !list.some((c) => c.parent === z.id);
    return drawn.map(([id, b]) => {
      const home = list
        .filter((z) => isLeaf(z) && contains(z, b.x + b.w / 2, b.y + b.h / 2))
        .sort((p, q) => p.w * p.h - q.w * q.h)[0];
      if (!home) throw new Error(`block "${id}" lies in no zone`);
      return { id, title: b.title, zone: home.id, x: n(b.x), y: n(b.y), w: n(b.w), h: n(b.h) };
    });
  }

  return { list, zone, around, checkTour, spots };
}
