import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAll } from '../../scripts/diagram/signal-flow.mjs';

/**
 * signal-flow-map.md REQ-the-poster-is-csp-safe / REQ-the-map-is-the-poster: the
 * committed posters are inlined by the app under its CSP, and the committed
 * manifest is what the generator writes.
 */
const read = (f: string): string => readFileSync(resolve('docs', f), 'utf8');

interface Zone { id: string; parent?: string; x: number; y: number; w: number; h: number }
interface Spot { id: string; zone: string; x: number; y: number; w: number; h: number }
interface Manifest { width: number; height: number; zones: Zone[]; tour: string[]; spots: Spot[] }

describe.each(['light', 'dark'])('docs/signal-flow-%s.svg', (variant) => {
  const svg = read(`signal-flow-${variant}.svg`);

  it('has no <style> and no style attribute', () => {
    expect(svg).not.toMatch(/<style/);
    expect(svg).not.toMatch(/\sstyle="/);
  });

  it('references nothing outside itself', () => {
    const hrefs = [...svg.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((h) => !h.startsWith('#'))).toEqual([]);
  });

  it('namespaces every id with sf-', () => {
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter((id) => !id.startsWith('sf-'))).toEqual([]);
  });
});

describe('docs/signal-flow-zones.json', () => {
  const m = JSON.parse(read('signal-flow-zones.json')) as Manifest;

  it('has unique ids, known parents, and every box inside its parent and the poster', () => {
    const byId = new Map(m.zones.map((z) => [z.id, z]));
    expect(byId.size).toBe(m.zones.length);
    for (const z of m.zones) {
      const outer = z.parent ? byId.get(z.parent) : { x: 0, y: 0, w: m.width, h: m.height };
      expect(outer, `${z.id}'s parent`).toBeDefined();
      expect(z.w, z.id).toBeGreaterThan(0);
      expect(z.h, z.id).toBeGreaterThan(0);
      expect(z.x, z.id).toBeGreaterThanOrEqual(outer!.x);
      expect(z.y, z.id).toBeGreaterThanOrEqual(outer!.y);
      expect(z.x + z.w, z.id).toBeLessThanOrEqual(outer!.x + outer!.w + 0.1);
      expect(z.y + z.h, z.id).toBeLessThanOrEqual(outer!.y + outer!.h + 0.1);
    }
  });

  it('puts every spot (drawn block) inside its zone, ids unique', () => {
    expect(m.spots.length).toBeGreaterThan(50);
    expect(new Set(m.spots.map((s) => s.id)).size).toBe(m.spots.length);
    for (const s of m.spots) {
      const z = m.zones.find((q) => q.id === s.zone);
      expect(z, s.id).toBeDefined();
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      expect(cx >= z!.x && cx <= z!.x + z!.w && cy >= z!.y && cy <= z!.y + z!.h, s.id).toBe(true);
    }
  });

  it('is what the generator writes (rerun npm run docs:diagram)', () => {
    expect(buildAll().zones).toEqual(m);
  });
});

// The posters print package.json's version, so a bump without a redraw would
// ship a map labelled with the last release; `npm run release` redraws them.
describe('the committed posters', () => {
  const built = buildAll() as { light: string; dark: string };
  // Compared line-normalised: Git may check the files out with CRLF.
  const lf = (s: string): string => s.replace(/\r\n/g, '\n');

  it.each(['light', 'dark'] as const)('%s is what the generator draws now (rerun npm run docs:diagram)', (v) => {
    expect(lf(read(`signal-flow-${v}.svg`)) === lf(built[v])).toBe(true);
  });
});
