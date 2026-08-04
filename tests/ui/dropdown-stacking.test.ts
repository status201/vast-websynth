// @vitest-environment node
//
// Drift pin for dropdown.md REQ-9: nothing may form a stacking context on a
// Dropdown *root*.
//
// The menu is `position: fixed`, which escapes every `overflow` ancestor — so
// the component reads as if it floats free. It does not: the menu is still a DOM
// *child* of the root, so one `opacity` there does two things at once. It
// composites the whole subtree as a group (the open option list fades with the
// toggle) and it opens a stacking context that traps the menu's `z-index: 1000`,
// letting later siblings paint over it. That shipped on the Motion tab's
// inherited axis pickers: unreadable options, menu buried under the XY pads.
//
// The jsdom suite never resolves CSS Modules to real CSS (`styles.dimmed` is
// just a string there), so — like `typography.test.ts` — this reads the
// stylesheets as text.
//
// Scope, honestly: this pins the component's own stylesheet. It cannot catch a
// consumer that declares `opacity` in its *own* module and hangs the class on
// `dd.el` from TypeScript, which is exactly how the original bug happened —
// there is no signal in the CSS to find. That path is closed instead by
// `Dropdown.setDimmed` being the obvious way to do this at all, by REQ-9 saying
// so out loud, and by `dropdown.test.ts` proving `setDimmed` skips the root.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STYLE_DIRS = ['../../src/ui/styles', '../../src/styles'];
const DROPDOWN_CSS = 'dropdown.module.css';

/** Classes that land on the Dropdown root element itself:
 *  `styles.root` (dropdown.ts) and `styles.compact` (param-dropdown.ts:18). */
const ROOT_CLASSES = ['root', 'compact'];

/** Properties that make an element a stacking context — the whole point of the
 *  rule. `z-index` only does so with a `position`, but `.root` is
 *  `position: relative`, so it counts here. */
const STACKING_PROPS = [
  'opacity',
  'transform',
  'filter',
  'backdrop-filter',
  'perspective',
  'will-change',
  'contain',
  'isolation',
  'mix-blend-mode',
  'z-index',
];

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Every top-level rule in the app's stylesheets. Same deliberately dumb parser
 *  as `typography.test.ts`: a drift pin, not a CSS engine. */
function readRules(): Rule[] {
  const rules: Rule[] = [];
  for (const dir of STYLE_DIRS) {
    const path = fileURLToPath(new URL(`${dir}/`, import.meta.url));
    for (const file of readdirSync(path).filter((n) => n.endsWith('.css')).sort()) {
      const css = readFileSync(path + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of m[1]!.split(',')) {
          const s = selector.trim().replace(/\s+/g, ' ');
          if (s) rules.push({ file, selector: s, body: m[2]! });
        }
      }
    }
  }
  return rules;
}

/** The classes on a selector's *subject* — the element the rule actually styles,
 *  i.e. its rightmost compound. `.root:global(.open) .menu` styles `.menu`, not
 *  the root; `.toggle.dimmed` styles an element that is both. */
function subjectClasses(selector: string): string[] {
  const subject = selector.split(/\s*[ >+~]\s*/).filter(Boolean).pop() ?? '';
  return [...subject.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

const declares = (body: string, prop: string) =>
  new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(body);

const rules = readRules();
const dropdownRules = rules.filter((r) => r.file === DROPDOWN_CSS);

describe('Dropdown stacking contexts (specs/features/dropdown.md REQ-9)', () => {
  it('parsed the stylesheets at all', () => {
    // Guards the guard: a parser matching nothing makes everything below
    // vacuously true.
    expect(rules.length).toBeGreaterThan(200);
    expect(dropdownRules.length).toBeGreaterThan(10);
    expect(subjectClasses('.root:global(.open) .menu')).toEqual(['menu']);
    expect(subjectClasses('.toggle.dimmed')).toEqual(['toggle', 'dimmed']);
  });

  it('never forms a stacking context on the root', () => {
    const offenders = dropdownRules
      .filter((r) => subjectClasses(r.selector).some((c) => ROOT_CLASSES.includes(c)))
      .flatMap((r) =>
        STACKING_PROPS.filter((p) => declares(r.body, p)).map(
          (p) => `${r.file} ${r.selector} { ${p} }`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('keeps the dimmed treatment compounded with the toggle', () => {
    const dimmed = dropdownRules.filter((r) => subjectClasses(r.selector).includes('dimmed'));
    // It exists…
    expect(dimmed.length).toBeGreaterThan(0);
    // …and every rule carrying it also names `.toggle`, so it cannot be written
    // in a form that would apply to the root.
    for (const r of dimmed) {
      expect(subjectClasses(r.selector), r.selector).toContain('toggle');
    }
  });

});
