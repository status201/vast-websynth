import { describe, it, expect } from 'vitest';
import shipped from '../../docs/signal-flow-zones.json';
import {
  ancestors, childrenOf, hotspotsFor, resolveLink, tourIndex, tourStep, zoneById, type ZoneManifest,
} from '../../src/ui/signal-flow/zones';

/**
 * signal-flow-map.md — the walks over the zone manifest
 * (REQ-picking-an-area-zooms-to-it, REQ-next-follows-the-signal). A synthetic
 * manifest, so the rules are pinned independently of the poster's content.
 */
const Z = (id: string, parent?: string) => ({ id, title: id.toUpperCase(), blurb: '', x: 0, y: 0, w: 1, h: 1, ...(parent ? { parent } : {}) });
const M: ZoneManifest = {
  width: 100,
  height: 100,
  intro: '',
  zones: [Z('a'), Z('b'), Z('a1', 'a'), Z('a2', 'a'), Z('b1', 'b'), Z('b1x', 'b1'), Z('b1y', 'b1')],
  tour: ['a1', 'a2', 'b1x', 'b1y'],
  spots: [
    { id: 'sa', title: 'SA', zone: 'a1', x: 0, y: 0, w: 1, h: 1 },
    { id: 'sx', title: 'SX', zone: 'b1x', x: 0, y: 0, w: 1, h: 1 },
    { id: 'sy', title: 'SY', zone: 'b1y', x: 0, y: 0, w: 1, h: 1 },
  ],
};

describe('zone walks', () => {
  it('finds children, top level for null', () => {
    expect(childrenOf(M, null).map((z) => z.id)).toEqual(['a', 'b']);
    expect(childrenOf(M, 'b1').map((z) => z.id)).toEqual(['b1x', 'b1y']);
  });

  it('lists ancestors outermost first', () => {
    expect(ancestors(M, 'b1x').map((z) => z.id)).toEqual(['b', 'b1']);
    expect(ancestors(M, 'a')).toEqual([]);
  });

  it('offers children, else siblings, as hotspots', () => {
    expect(hotspotsFor(M, null).map((z) => z.id)).toEqual(['a', 'b']);
    expect(hotspotsFor(M, 'a').map((z) => z.id)).toEqual(['a1', 'a2']);
    expect(hotspotsFor(M, 'a1').map((z) => z.id)).toEqual(['a2']);
  });
});

describe('tourStep', () => {
  it('starts at the first stop from the overview and cannot go back from it', () => {
    expect(tourStep(M, null, 1)).toEqual({ to: 'a1' });
    expect(tourStep(M, null, -1)).toBeNull();
  });

  it('walks the stops, back to the overview from the first', () => {
    expect(tourStep(M, 'a1', 1)).toEqual({ to: 'a2' });
    expect(tourStep(M, 'a1', -1)).toEqual({ to: null });
    expect(tourStep(M, 'b1y', 1)).toBeNull();
  });

  it('from an area, Next is its first stop and Prev the stop before', () => {
    expect(tourStep(M, 'b', 1)).toEqual({ to: 'b1x' });
    expect(tourStep(M, 'b', -1)).toEqual({ to: 'a2' });
    expect(tourStep(M, 'a', -1)).toEqual({ to: null });
  });

  it('numbers the stops from 1', () => {
    expect(tourIndex(M, 'b1x')).toBe(3);
    expect(tourIndex(M, 'b')).toBe(0);
    expect(tourIndex(M, null)).toBe(0);
  });
});

describe('resolveLink (REQ-a-help-topic-shows-its-place)', () => {
  it('frames a spot’s own zone and rings the spot', () => {
    const t = resolveLink(M, ['sx']);
    expect(t?.zone).toBe('b1x');
    expect(t?.spots.map((s) => s.id)).toEqual(['sx']);
  });

  it('frames the innermost zone that holds every id, zones and spots alike', () => {
    expect(resolveLink(M, ['sx', 'sy'])?.zone).toBe('b1');
    expect(resolveLink(M, ['b1y', 'sx'])?.zone).toBe('b1');
    expect(resolveLink(M, ['a2'])).toEqual({ zone: 'a2', spots: [] });
  });

  it('falls back to the overview across top-level areas, and to null for nothing known', () => {
    expect(resolveLink(M, ['sa', 'sx'])?.zone).toBeNull();
    expect(resolveLink(M, ['nope'])).toBeNull();
  });
});

describe('the shipped manifest', () => {
  const m = shipped as ZoneManifest;

  it('tours only leaf zones that exist, each once', () => {
    expect(new Set(m.tour).size).toBe(m.tour.length);
    for (const id of m.tour) {
      expect(zoneById(m, id), id).toBeDefined();
      expect(childrenOf(m, id), id).toEqual([]);
    }
  });

  it('tours every leaf', () => {
    const leaves = m.zones.filter((z) => childrenOf(m, z.id).length === 0).map((z) => z.id);
    expect([...m.tour].sort()).toEqual(leaves.sort());
  });
});
