// @vitest-environment node
//
// Drift pin for the tabbed/plain panel header match (panel-tabs.md REQ-9).
//
// A tab strip *replaces* a panel title, so the two must occupy the same height
// or the LFO panel's controls sit off the baseline of every panel beside it.
// `e2e/lfo2.spec.ts` measures that in a real browser — but it only measures the
// browser it runs in, and the bug this pin was written for was invisible on the
// author's machine: `.panelTitle` left `line-height` to the font, and `--sans`
// is `'Inter', system-ui, …` with no webfont behind it. Segoe UI gave 10px text
// a 14px line box (a 21px header, matching the tabs); the Linux CI runner's
// fallback gave 11px (an 18px header under a 21px tab row).
//
// So the requirement is really about the *stylesheet*: both rules must state
// their vertical metrics outright, and the two sums must agree. That is what
// this file checks, and it checks it wherever `npm test` runs. The jsdom suite
// cannot: CSS Modules are never resolved to real CSS there, so `styles.panelTab`
// is only a string. This reads the sheet as text, like tests/ui/typography.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(
  fileURLToPath(new URL('../../src/ui/styles/layout.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The bodies of every rule whose selector is exactly `selector`. Deliberately a
 *  dumb parser (see typography.test.ts): an `@media` wrapper is skipped over
 *  rather than parsed, so an override nested in one still matches here — which
 *  is the point, since the two headers must agree at every width. */
const bodies = (selector: string): string[] =>
  [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.trim().replace(/\s+/g, ' ') === selector)
    .map((m) => m[2]!);

/** A declaration's value, or undefined if the rule does not set it. */
const decl = (body: string, prop: string): string | undefined =>
  new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

/** A px length, asserted to be one — a unitless or `em` value would reintroduce
 *  exactly the font dependence this pin exists to forbid. */
function px(value: string | undefined, what: string): number {
  expect(value, `${what} must be declared`).toBeDefined();
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value!.trim());
  expect(m, `${what} must be an absolute px length, got "${value}"`).not.toBeNull();
  return Number(m![1]);
}

/**
 * The laid-out height of a single-line header box, from its declarations alone.
 *
 * Everything is `box-sizing: border-box` (base.css), and these boxes are sized
 * by their content, so height = line box + vertical padding + vertical borders.
 * Only the shorthand/longhand forms the two rules actually use are understood:
 * anything else fails loudly rather than quietly scoring 0, so a rewrite of
 * either rule has to come back through this file.
 */
function headerHeight(body: string, what: string): number {
  const side = (prop: 'padding' | 'border', edge: 'top' | 'bottom'): number => {
    const short = decl(body, prop);
    if (short !== undefined) {
      // `padding: 3px 6px` → vertical is the 1st value; `border: 1px solid …` →
      // the width is the 1st token. Both apply to every edge.
      return px(short.split(/\s+/)[0], `${what} ${prop} width`);
    }
    const long = decl(body, `${prop}-${edge}`);
    if (long === undefined) return 0;          // not set on this edge = 0
    return px(long.split(/\s+/)[0], `${what} ${prop}-${edge} width`);
  };

  const line = px(decl(body, 'line-height'), `${what} line-height`);
  return (
    line +
    side('padding', 'top') + side('padding', 'bottom') +
    side('border', 'top') + side('border', 'bottom')
  );
}

describe('panel header height (specs/features/panel-tabs.md REQ-9)', () => {
  const title = bodies('.panelTitle');
  const tab = bodies('.panelTab');

  it('parsed one governing rule for each header, at every width', () => {
    // Guards the guard — and catches the other way this could break: a media
    // query that retunes one header's metrics without the other's.
    expect(title, '.panelTitle rules').toHaveLength(1);
    expect(tab, '.panelTab rules').toHaveLength(1);
  });

  it('states both line-heights in px rather than inheriting the font (regression)', () => {
    // The bug: only the tab declared one. `line-height: normal` at 10px is 14px
    // on Segoe UI and 11px on the CI runner's sans, so the match held on the
    // machine it was written on and nowhere else.
    px(decl(title[0]!, 'line-height'), '.panelTitle line-height');
    px(decl(tab[0]!, 'line-height'), '.panelTab line-height');
  });

  it('makes a tab exactly as tall as a plain title', () => {
    // 14 + 6 + 1 against 13 + 3 + 3 + 1 + 1. The number is free to change; the
    // two staying equal is the contract, and e2e/lfo2.spec.ts measures the same
    // equality on the rendered rows.
    const t = headerHeight(title[0]!, '.panelTitle');
    expect(headerHeight(tab[0]!, '.panelTab'), 'tab vs title header height').toBe(t);
    expect(t, 'the header height today').toBe(21);
  });
});
