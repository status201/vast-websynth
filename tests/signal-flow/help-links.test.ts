import { describe, it, expect } from 'vitest';
import shipped from '../../docs/signal-flow-zones.json';
import { SIGNAL_FLOW_LINKS } from '../../src/ui/signal-flow/help-links';
import { resolveLink, zoneById, type ZoneManifest } from '../../src/ui/signal-flow/zones';

/**
 * signal-flow-map.md REQ-a-help-topic-shows-its-place: every help topic's link
 * names blocks or zones that exist on the poster, and lands on one area — never
 * the bare overview, which would show the reader nothing.
 */
const m = shipped as ZoneManifest;
const links = Object.entries(SIGNAL_FLOW_LINKS) as [string, readonly string[]][];

describe('help topic → signal-flow links', () => {
  it('covers the topics on the signal path', () => {
    expect(links.length).toBeGreaterThan(60);
  });

  it.each(links)('%s names only blocks or zones that exist', (_topic, ids) => {
    expect(ids.length).toBeGreaterThan(0);
    const unknown = ids.filter((id) => !zoneById(m, id) && !m.spots.some((s) => s.id === id));
    expect(unknown).toEqual([]);
  });

  it.each(links)('%s lands on an area, not the overview', (_topic, ids) => {
    const target = resolveLink(m, ids);
    expect(target).not.toBeNull();
    expect(target!.zone).not.toBeNull();
  });
});
