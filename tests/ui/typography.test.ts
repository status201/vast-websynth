// @vitest-environment node
//
// Drift pin for the type rule (specs/features/typography.md).
//
// Nothing else in the repo can catch a typography regression: `sdd-guard.mjs`
// allowlists `*.css` and `**/styles/**`, and the jsdom suite never resolves CSS
// Modules to real CSS — `styles.filterInput` is just a string there. So this
// reads the stylesheets as text.
//
// The serif is the faceplate voice, so it spreads by imitation: a new rule gets
// `var(--serif)` because the rule above it had one. That is how it landed on the
// dropdown's filter *input*, at 10px, with legend tracking. The allowlist below
// makes each use deliberate — a new one fails this test until someone adds it,
// which is the moment they read the spec.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STYLE_DIRS = ['../../src/ui/styles', '../../src/styles'];

/** Selectors that may render in `--serif` — display type only (REQ-1). */
const DISPLAY_TYPE = [
  // — identity & headings —
  'brand.module.css .brandName',
  'brand.module.css .brandTagline',
  'modal.module.css .title',
  'modal.module.css .tag',
  'tour.module.css .calloutTitle',
  // The info badge's content is the letter `i`, not a number — the serif italic
  // *is* the info mark. Display type doing its job; not a REQ-3 case.
  'tour.module.css .badge',
  // — faceplate legends —
  'bank-bar.module.css .btn',
  'drum.module.css .trackLabel',
  'dropdown.module.css .toggle',
  'dropdown.module.css .option',
  'floating-window.module.css .closeBtn',
  'floating-window.module.css .minBtn',
  'keyboard.module.css .key',
  'rest-overlay.module.css .caption',
  'segmented.module.css .root button, :global(.segmented) button',
  'seq.module.css .noteDisplay',
  'song-panel.module.css .chip',
  'step-button.module.css .root',
  'tabs.module.css .tab',
  'xy-pad.module.css .fieldLabel',
];

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Every top-level rule in the app's stylesheets. Deliberately a dumb parser:
 *  this is a drift pin, not a CSS engine. Comments are stripped, and an
 *  `@media` wrapper is skipped over rather than parsed (its inner rules still
 *  match, since only innermost brace-free blocks can). */
function readRules(): Rule[] {
  const rules: Rule[] = [];
  for (const dir of STYLE_DIRS) {
    const path = fileURLToPath(new URL(`${dir}/`, import.meta.url));
    for (const file of readdirSync(path).filter((n) => n.endsWith('.css')).sort()) {
      const css = readFileSync(path + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        rules.push({
          file,
          selector: m[1]!.trim().replace(/\s+/g, ' '),
          body: m[2]!,
        });
      }
    }
  }
  return rules;
}

const rules = readRules();
const faceOf = (r: Rule) => /font-family:\s*([^;]+);/.exec(r.body)?.[1]?.trim();
const find = (file: string, selector: string) =>
  rules.find((r) => r.file === file && r.selector === selector);

describe('the type rule (specs/features/typography.md)', () => {
  it('parsed the stylesheets at all', () => {
    // Guards the guard: a parser that silently matched nothing would make every
    // other assertion here vacuously true.
    expect(rules.length).toBeGreaterThan(200);
  });

  it('uses --serif only for declared display type (REQ-1, REQ-6)', () => {
    const serif = rules
      .filter((r) => faceOf(r) === 'var(--serif)')
      .map((r) => `${r.file} ${r.selector}`);

    // An exact set match, both directions: a *new* serif use fails as
    // unexpected, and an allowlist entry whose declaration was removed fails as
    // stale — so the list cannot rot into a rubber stamp.
    expect([...serif].sort()).toEqual([...DISPLAY_TYPE].sort());
  });

  it('renders the dropdown filter row as content, not legend (regression, REQ-2)', () => {
    // The bug this pin was written for: both were var(--serif), copied from the
    // sibling .option rule when the filter row was added.
    expect(faceOf(find('dropdown.module.css', '.filterInput')!)).toBe('var(--sans)');
    expect(faceOf(find('dropdown.module.css', '.empty')!)).toBe('var(--sans)');
  });

  it('keeps the dropdown toggle and options on the faceplate serif (REQ-1)', () => {
    // The other half of the same decision — the fix was scoped to the menu's
    // content, and the legends around it must not drift to sans by imitation.
    expect(faceOf(find('dropdown.module.css', '.toggle')!)).toBe('var(--serif)');
    expect(faceOf(find('dropdown.module.css', '.option')!)).toBe('var(--serif)');
  });

  it('sets live position readouts in --mono (regression, REQ-3)', () => {
    // Both count while the transport runs. Georgia's figures are proportional
    // old-style with no `tnum`, so a serif counter shifts sideways per digit.
    expect(faceOf(find('transport-controls.module.css', '.readout')!)).toBe('var(--mono)');
    expect(faceOf(find('playhead-ruler.module.css', '.bar')!)).toBe('var(--mono)');
  });

  it('defines all three faces in one place (REQ-3)', () => {
    const root = find('theme.css', ':root')!;
    expect(root.body).toMatch(/--serif:.*Georgia/);
    expect(root.body).toMatch(/--sans:.*Inter/);
    expect(root.body).toMatch(/--mono:.*ui-monospace/);
  });
});
