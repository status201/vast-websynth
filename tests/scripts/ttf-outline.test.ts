import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadTtf } from '../../scripts/lib/ttf-outline.mjs';

/**
 * The zero-dependency glyph outliner behind the social card's type
 * (specs/features/pwa-install.md REQ-apple-touch-icon-is-opaque): static
 * TrueType in, SVG path data out, at the origin and size the caller gives.
 */
const font = (file: string) => loadTtf(readFileSync(`scripts/fonts/barlow/${file}`));
const bold = font('Barlow-Bold.ttf');

/** Every coordinate pair in a path, as numbers. */
const points = (d: string) => {
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i]!, nums[i + 1]!]);
  return out;
};
const contours = (d: string) => (d.match(/M/g) ?? []).length;

describe('ttf-outline', () => {
  it('reads the em size and maps characters to glyphs', () => {
    expect(bold.unitsPerEm).toBe(1000);
    expect(bold.glyphOf('V')).toBeGreaterThan(0);
    expect(bold.glyphOf('V')).not.toBe(bold.glyphOf('A'));
  });

  it('draws each contour closed, one subpath per contour', () => {
    const v = bold.glyphPath(bold.glyphOf('V'), 0, 0, 100);
    const a = bold.glyphPath(bold.glyphOf('A'), 0, 0, 100);
    const o = bold.glyphPath(bold.glyphOf('O'), 0, 0, 100);
    for (const d of [v, a, o]) {
      expect(d.startsWith('M')).toBe(true);
      expect(d.endsWith('Z')).toBe(true);
      expect((d.match(/Z/g) ?? []).length).toBe(contours(d));
    }
    expect(contours(v)).toBe(1);
    expect(contours(a)).toBe(2); // the outline and the counter
    expect(contours(o)).toBe(2);
    expect(o).toContain('Q'); // curves come out as quadratics
  });

  it('places the glyph at the origin and size given, y down from the baseline', () => {
    const size = 200;
    const [ox, oy] = [300, 500];
    const pts = points(bold.glyphPath(bold.glyphOf('H'), ox, oy, size));
    const xs = pts.map(([x]) => x);
    const ys = pts.map(([, y]) => y);
    // H sits on the baseline and rises about a cap height (0.7 em) above it.
    expect(Math.max(...ys)).toBeCloseTo(oy, 0);
    expect(oy - Math.min(...ys)).toBeGreaterThan(0.6 * size);
    expect(oy - Math.min(...ys)).toBeLessThan(0.8 * size);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(ox);
    expect(Math.max(...xs)).toBeLessThan(ox + size);
  });

  it('assembles composite glyphs from their components', () => {
    // Ä: the A's two contours plus the two dots of the dieresis.
    expect(contours(bold.glyphPath(bold.glyphOf('Ä'), 0, 0, 100))).toBe(4);
  });

  it('draws nothing for a space', () => {
    expect(bold.glyphPath(bold.glyphOf(' '), 0, 0, 100)).toBe('');
  });

  it('throws for a character the font lacks', () => {
    expect(() => bold.glyphOf('漢')).toThrow(/no glyph/);
  });

  it('refuses a variable font rather than drawing its default instance', () => {
    // A table directory holding one 'gvar' record is enough to be refused.
    const bytes = new Uint8Array(12 + 16);
    const v = new DataView(bytes.buffer);
    v.setUint32(0, 0x00010000);
    v.setUint16(4, 1);
    [...'gvar'].forEach((ch, i) => v.setUint8(12 + i, ch.charCodeAt(0)));
    expect(() => loadTtf(bytes)).toThrow(/variable fonts/);
  });
});
