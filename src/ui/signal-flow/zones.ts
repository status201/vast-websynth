/**
 * The signal-flow map's zones: the shape of `docs/signal-flow-zones.json` and the
 * walks over it (signal-flow-map.md).
 *
 * The manifest is written by `scripts/diagram/signal-flow.mjs` next to the two
 * posters, from the same layout that draws them; the map knows nothing about
 * the synth beyond what this file describes.
 */
import type { Rect } from './camera';

export interface Zone extends Rect {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  /** Absent for a top-level area. */
  readonly parent?: string;
}

/** A drawn block of the poster, by its layout id — what a deep link rings. */
export interface Spot extends Rect {
  readonly id: string;
  /** The block's own title on the poster (FILTER, MASTER COMP…). */
  readonly title: string;
  /** The leaf zone it sits in. */
  readonly zone: string;
}

export interface ZoneManifest {
  readonly width: number;
  readonly height: number;
  /** What the panel says at the overview. */
  readonly intro: string;
  readonly zones: readonly Zone[];
  /** "Follow the signal": the leaf zones in the order Prev / Next walks them. */
  readonly tour: readonly string[];
  /** Every drawn block. */
  readonly spots: readonly Spot[];
}

export function zoneById(m: ZoneManifest, id: string): Zone | undefined {
  return m.zones.find((z) => z.id === id);
}

/** The zones directly under `id`, or the top-level ones for `null`, in manifest order. */
export function childrenOf(m: ZoneManifest, id: string | null): Zone[] {
  return m.zones.filter((z) => (z.parent ?? null) === id);
}

/** The zones above `id`, outermost first; empty for a top-level zone. */
export function ancestors(m: ZoneManifest, id: string): Zone[] {
  const out: Zone[] = [];
  let z = zoneById(m, id);
  while (z?.parent) {
    z = zoneById(m, z.parent);
    if (z) out.unshift(z);
  }
  return out;
}

/** Whether `id` is `root` or lies inside it. */
function within(m: ZoneManifest, id: string, root: string): boolean {
  return id === root || ancestors(m, id).some((a) => a.id === root);
}

/**
 * The zones a focus offers as hotspots: its children; for a zone without any,
 * its siblings (so a neighbour is one click away); at the overview, the
 * top-level areas.
 */
export function hotspotsFor(m: ZoneManifest, focus: string | null): Zone[] {
  if (focus === null) return childrenOf(m, null);
  const kids = childrenOf(m, focus);
  if (kids.length) return kids;
  return childrenOf(m, zoneById(m, focus)?.parent ?? null).filter((z) => z.id !== focus);
}

/** Where Prev / Next go: a zone id, `null` for the overview. */
export interface TourStep {
  readonly to: string | null;
}

/**
 * One step along the tour from `focus` (`null` = the overview), or `null` when
 * there is nowhere to go that way. From an area that is not itself a stop, Next
 * is its first stop and Prev the stop before that.
 */
export function tourStep(m: ZoneManifest, focus: string | null, dir: 1 | -1): TourStep | null {
  const t = m.tour;
  if (!t.length) return null;
  if (focus === null) return dir === 1 ? { to: t[0]! } : null;
  const at = t.indexOf(focus);
  if (at >= 0) {
    const i = at + dir;
    if (i < 0) return { to: null };
    return i < t.length ? { to: t[i]! } : null;
  }
  const first = t.findIndex((id) => within(m, id, focus));
  if (first < 0) return null;
  if (dir === 1) return { to: t[first]! };
  return first > 0 ? { to: t[first - 1]! } : { to: null };
}

/** `focus`'s place on the tour, 1-based, or 0 when it is not a stop. */
export function tourIndex(m: ZoneManifest, focus: string | null): number {
  return focus === null ? 0 : m.tour.indexOf(focus) + 1;
}

/** The innermost zone holding every one of `ids` (each in or under it); `null` = only the overview does. */
function commonZone(m: ZoneManifest, ids: readonly string[]): string | null {
  const chains = ids.map((id) => [...ancestors(m, id).map((z) => z.id), id]);
  const first = chains[0];
  if (!first) return null;
  let common: string | null = null;
  for (let i = 0; i < first.length; i++) {
    if (!chains.every((c) => c[i] === first[i])) break;
    common = first[i]!;
  }
  return common;
}

/** Where a deep link lands: the zone to frame and the blocks to ring. */
export interface LinkTarget {
  readonly zone: string | null;
  readonly spots: readonly Spot[];
}

/**
 * Resolve a deep link (signal-flow-map.md REQ-a-help-topic-shows-its-place):
 * each id names a zone or a spot. The view frames the innermost zone that holds
 * all of them; the spots are ringed. Unknown ids are dropped; `null` when
 * nothing is left.
 */
export function resolveLink(m: ZoneManifest, ids: readonly string[]): LinkTarget | null {
  const spots = ids.map((id) => m.spots.find((s) => s.id === id)).filter((s): s is Spot => !!s);
  const zones = ids.filter((id) => zoneById(m, id));
  const homes = [...zones, ...spots.map((s) => s.zone)];
  if (!homes.length) return null;
  return { zone: commonZone(m, homes), spots };
}
