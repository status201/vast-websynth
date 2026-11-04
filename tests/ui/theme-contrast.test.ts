// @vitest-environment node
//
// Text contrast per theme (specs/features/ui-themes.md REQ-high-contrast-reads-at-seven-to-one,
// REQ-light-body-text-meets-aa). WCAG 2 ratios, computed from the theme files' own
// flat colour tokens: each text token against each surface text sits on.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const themeTokens = (id: string): Map<string, string> => {
  const css = readFileSync(path.join(process.cwd(), `src/styles/themes/${id}.css`), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const map = new Map<string, string>();
  for (const b of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!b[1]!.trim().startsWith(`:root[data-theme="${id}"]`)) continue;
    for (const t of b[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(t[1]!, t[2]!.trim());
  }
  return map;
};

/** WCAG relative luminance of a #rrggbb. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Every flat surface text is printed on: the page, a panel, a button's well, a field, a tray, a tab strip, a selected control. */
const SURFACES = [
  '--bg', '--panel-flat', '--well-top', '--well-bottom', '--field',
  '--tray-top', '--tray-bottom', '--recess-top', '--recess-bottom', '--raised-top', '--raised-bottom',
];
const BODY = ['--text', '--text-soft', '--text-dim'];
const SMALL_PRINT = ['--text-label', '--text-hint', '--text-bad', '--text-error', '--text-good', '--accent', '--accent-secondary'];

/** Each failing pair as `text on surface = ratio`, so a failure names what to fix. */
function below(id: string, texts: string[], min: number): string[] {
  const t = themeTokens(id);
  const out: string[] = [];
  for (const fg of texts) {
    for (const bg of SURFACES) {
      const a = t.get(fg);
      const b = t.get(bg);
      expect(a, `${id}: ${fg}`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(b, `${id}: ${bg}`).toMatch(/^#[0-9a-f]{6}$/i);
      const r = contrast(a!, b!);
      if (r < min) out.push(`${fg} on ${bg} = ${r.toFixed(2)}`);
    }
  }
  return out;
}

describe('theme contrast', () => {
  it('measures the way WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('reads at 7:1 or better everywhere in High contrast (REQ-high-contrast-reads-at-seven-to-one)', () => {
    expect(below('contrast', [...BODY, ...SMALL_PRINT, '--text-faint'], 7)).toEqual([]);
  });

  it('gives Light body text 4.5:1 and its small print 3:1 (REQ-light-body-text-meets-aa)', () => {
    expect(below('light', BODY, 4.5)).toEqual([]);
    expect(below('light', SMALL_PRINT, 3)).toEqual([]);
  });
});
