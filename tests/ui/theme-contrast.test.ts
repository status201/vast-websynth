// @vitest-environment node
//
// Text contrast per theme (specs/features/ui-themes.md REQ-every-theme-states-its-contrast
// and the per-theme REQs its RULES name). WCAG 2 ratios, computed from the theme
// files' own flat colour tokens: each text token against each surface text sits
// on, a selected control's two legends on its bed, and type on its own fills.
import { describe, it, expect } from 'vitest';
import { resolvedToken as resolved } from '../theme-css';
import { THEMES } from '../../src/state/theme';

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

/** Every flat surface any text is printed on: the page, a panel, a button's well, a field, a tray, a tab strip. */
const SURFACES = [
  '--bg', '--panel-flat', '--well-top', '--well-bottom', '--field',
  '--tray-top', '--tray-bottom', '--recess-top', '--recess-bottom',
];
/**
 * A selected control's bed (--raised) carries only two legends: the lit accent
 * (small print's tier) and an armed segment's --text-soft (body's tier;
 * segmented.module.css). Checked as those pairs rather than every text token.
 */
const RAISED = ['--raised-top', '--raised-bottom'];
/** The section faces a theme may colour (REQ-pastel-tints-each-panel). */
const TINTS = ['osc', 'mixer', 'filter', 'env', 'mod', 'fx'].map((s) => `--panel-tint-${s}`);
const BODY = ['--text', '--text-soft', '--text-dim'];
const SMALL_PRINT = ['--text-label', '--text-hint', '--text-bad', '--text-error', '--text-good', '--accent', '--accent-secondary'];

/**
 * Two tokens' ratio as the theme computes them (`var()` followed). Each must be one
 * flat #rrggbb: anything else would measure NaN, and NaN is never "below" a minimum.
 */
function ratio(id: string, fg: string, bg: string): number {
  const a = resolved(id, fg);
  const b = resolved(id, bg);
  expect(a, `${id}: ${fg}`).toMatch(/^#[0-9a-f]{6}$/i);
  expect(b, `${id}: ${bg}`).toMatch(/^#[0-9a-f]{6}$/i);
  return contrast(a, b);
}

/** Each failing pair as `id: text on surface = ratio`, so a failure names what to fix. */
function below(id: string, texts: string[], min: number, surfaces = SURFACES): string[] {
  const out: string[] = [];
  for (const fg of texts) {
    for (const bg of surfaces) {
      const r = ratio(id, fg, bg);
      if (r < min) out.push(`${id}: ${fg} on ${bg} = ${r.toFixed(2)}`);
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

/**
 * Each shipped theme's text rule: body text and small print on every flat surface
 * its type sits on. WCAG AA (4.5:1 body, 3:1 small print) is the floor; High
 * contrast holds everything, --text-faint included, to AAA.
 */
interface Rule { req: string; body: number; small: number; surfaces?: string[]; alsoBody?: string[] }
const RULES: Record<string, Rule> = {
  dark: { req: 'REQ-every-theme-states-its-contrast', body: 4.5, small: 3 },
  light: { req: 'REQ-light-body-text-meets-aa', body: 4.5, small: 3 },
  // Not on --bg: Pastel's page is the black chassis, which carries no type.
  pastel: { req: 'REQ-pastel-reads-on-every-tint', body: 4.5, small: 3, surfaces: [...SURFACES.filter((s) => s !== '--bg'), ...TINTS] },
  vibrant: { req: 'REQ-vibrant-keeps-its-red-for-fills', body: 4.5, small: 3 },
  contrast: { req: 'REQ-high-contrast-reads-at-seven-to-one', body: 7, small: 7, alsoBody: ['--text-faint'] },
};
const IDS = THEMES.map((t) => t.id);

/**
 * The flat colours an on switch's legend sits on: the theme's lit cap, or — where
 * the on bed is the well, a gradient (Dark) — both ends of the well.
 */
function onBeds(id: string): string[] {
  const lit = resolved(id, '--switch-on-bed') !== resolved(id, '--well');
  return lit ? ['--switch-on-bed'] : ['--well-top', '--well-bottom'];
}

describe('theme contrast', () => {
  it('measures the way WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('holds every shipped theme to a stated contrast rule (REQ-every-theme-states-its-contrast)', () => {
    // A theme with no row here fails: a new theme states its rule before it ships.
    expect(IDS.filter((id) => !(id in RULES))).toEqual([]);
    for (const id of IDS) {
      const r = RULES[id]!;
      const at = `${id} (${r.req})`;
      expect(below(id, [...BODY, ...(r.alsoBody ?? [])], r.body, r.surfaces), at).toEqual([]);
      expect(below(id, SMALL_PRINT, r.small, r.surfaces), at).toEqual([]);
      expect(below(id, ['--text-soft'], r.body, RAISED), `${at}, an armed segment`).toEqual([]);
      expect(below(id, ['--accent-secondary'], r.small, RAISED), `${at}, a selected control`).toEqual([]);
    }
  });

  it('keeps type on its own fills legible in every theme (regression)', () => {
    const bad = IDS.flatMap((id) => INKED_FILLS.flatMap(([ink, fill]) => below(id, [ink], 4.5, [fill])));
    expect(bad).toEqual([]);
  });

  it('makes an on switch read as on without its LED, in every theme (regression, REQ-an-on-switch-reads-as-on)', () => {
    for (const id of IDS) {
      const inkStep = ratio(id, '--switch-on-ink', '--text-dim');
      expect(onBeds(id)[0] === '--switch-on-bed' || inkStep >= 2, `${id}: same bed, ink step ${inkStep.toFixed(2)}`).toBe(true);
    }
    // The legend is still type on whatever bed it lands on.
    expect(IDS.flatMap((id) => below(id, ['--switch-on-ink'], 4.5, onBeds(id)))).toEqual([]);
  });

  it('prints the Play legend legibly on its on bed, in every theme (regression, REQ-an-on-switch-reads-as-on)', () => {
    expect(IDS.flatMap((id) => below(id, ['--play-on-ink'], 4.5, onBeds(id)))).toEqual([]);
  });
});
