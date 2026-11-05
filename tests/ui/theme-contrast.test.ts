// @vitest-environment node
//
// Text contrast per theme (specs/features/ui-themes.md REQ-high-contrast-reads-at-seven-to-one,
// REQ-light-body-text-meets-aa, REQ-pastel-reads-on-every-tint). WCAG 2 ratios, computed from the theme files' own
// flat colour tokens: each text token against each surface text sits on.
import { describe, it, expect } from 'vitest';
import { resolvedToken as resolved, themeTokens } from '../theme-css';

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
/** The section faces a theme may colour (REQ-pastel-tints-each-panel). */
const TINTS = ['osc', 'mixer', 'filter', 'env', 'mod', 'fx'].map((s) => `--panel-tint-${s}`);
const BODY = ['--text', '--text-soft', '--text-dim'];
const SMALL_PRINT = ['--text-label', '--text-hint', '--text-bad', '--text-error', '--text-good', '--accent', '--accent-secondary'];

/** Each failing pair as `text on surface = ratio`, so a failure names what to fix. */
function below(id: string, texts: string[], min: number, surfaces = SURFACES): string[] {
  const t = themeTokens(id);
  const out: string[] = [];
  for (const fg of texts) {
    for (const bg of surfaces) {
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

/**
 * Type printed on a fill that is not a surface: the bar the playhead is in, the
 * About card's keycaps, a lit DJ button and the info badge. Found by eye in Pastel, where a deep yellow and a
 * black cap had dark type on them; pinned for every theme.
 */
const INKED_FILLS: [ink: string, fill: string][] = [
  ['--ink-strong', '--playing'],
  ['--keycap-ink', '--keycap'],
  ['--keycap-sharp-ink', '--keycap'],
  ['--ink', '--lit-accent'],
  ['--lit-accent-ink', '--lit-accent'],
];

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

  it('keeps type on its own fills legible in every theme (regression)', () => {
    const bad: string[] = [];
    for (const id of ['dark', 'light', 'pastel', 'vibrant', 'contrast']) {
      for (const [ink, fill] of INKED_FILLS) {
        const a = resolved(id, ink);
        const b = resolved(id, fill);
        expect(a, `${id}: ${ink}`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(b, `${id}: ${fill}`).toMatch(/^#[0-9a-f]{6}$/i);
        const r = contrast(a, b);
        if (r < 4.5) bad.push(`${id}: ${ink} on ${fill} = ${r.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('makes an on switch read as on without its LED, in every theme (regression, REQ-an-on-switch-reads-as-on)', () => {
    for (const id of ['dark', 'light', 'pastel', 'vibrant', 'contrast']) {
      const bedChanges = resolved(id, '--switch-on-bed') !== resolved(id, '--well');
      const inkStep = contrast(resolved(id, '--switch-on-ink'), resolved(id, '--text-dim'));
      expect(bedChanges || inkStep >= 2, `${id}: same bed, ink step ${inkStep.toFixed(2)}`).toBe(true);
      // A lit cap's legend is still type on a fill.
      if (bedChanges) {
        const bed = resolved(id, '--switch-on-bed');
        expect(bed, `${id}: --switch-on-bed`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrast(resolved(id, '--switch-on-ink'), bed), id).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('prints the Play legend legibly on its on bed, in every theme (regression, REQ-an-on-switch-reads-as-on)', () => {
    const bad: string[] = [];
    for (const id of ['dark', 'light', 'pastel', 'vibrant', 'contrast']) {
      const ink = resolved(id, '--play-on-ink');
      expect(ink, `${id}: --play-on-ink`).toMatch(/^#[0-9a-f]{6}$/i);
      // Dark's on bed is its well, a gradient: the legend must read on both ends.
      const lit = resolved(id, '--switch-on-bed') !== resolved(id, '--well');
      for (const bed of lit ? ['--switch-on-bed'] : ['--well-top', '--well-bottom']) {
        const r = contrast(ink, resolved(id, bed));
        if (r < 4.5) bad.push(`${id}: --play-on-ink on ${bed} = ${r.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives Vibrant the same as Light on every surface (REQ-vibrant-keeps-its-red-for-fills)', () => {
    expect(below('vibrant', BODY, 4.5)).toEqual([]);
    expect(below('vibrant', SMALL_PRINT, 3)).toEqual([]);
  });

  it('gives Pastel the same on every surface and every section face (REQ-pastel-reads-on-every-tint)', () => {
    // Not on --bg: Pastel's page is the black chassis, which carries no type.
    const faces = [...SURFACES.filter((s) => s !== '--bg'), ...TINTS];
    expect(below('pastel', BODY, 4.5, faces)).toEqual([]);
    expect(below('pastel', SMALL_PRINT, 3, faces)).toEqual([]);
  });
});
