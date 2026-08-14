// @vitest-environment node
//
// Drift pin for REQ-10 of specs/features/runtime-performance.md: no compositing
// effect whose cost scales with the viewport may sit on a persistent overlay.
//
// REQ-10 is a frame-rate rule, and a jsdom test cannot measure frames. What it
// *can* do is pin the one declaration that broke it, which is worth doing
// because nothing else in the repo would catch a re-add: `sdd-guard.mjs`
// allowlists `*.css` and `**/styles/**`, so a blur can go back onto the modal
// backdrop without ever touching a spec. The manual measurement REQ-10 was
// derived from is written down under "Tests & verification" in that spec.
//
// Same shape and the same reasoning as `typography.test.ts`, which pins the
// type rule against the same class of by-imitation drift — a new overlay gets a
// `backdrop-filter` because it is copying the one above it. That is exactly how
// the tour's centred step acquired its copy of the modal backdrop's blur.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STYLE_DIRS = ['../../src/ui/styles', '../../src/styles'];

/**
 * Selectors permitted to declare `backdrop-filter`.
 *
 * Empty, and that is the point rather than an oversight: every overlay in this
 * app is full-viewport and lives for as long as its dialog is open, which is
 * precisely the shape REQ-10 forbids. A genuinely small or gesture-scoped one
 * could be added here — with a note saying which, and why it is not the
 * viewport — and the reviewer would then be reading REQ-10 while doing it.
 */
const VIEWPORT_EFFECT_OK: string[] = [];

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Every top-level rule in the app's stylesheets. Deliberately a dumb parser:
 *  this is a drift pin, not a CSS engine — the same one `typography.test.ts`
 *  uses, kept identical so the two pins cannot disagree about what a rule is. */
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
const find = (file: string, selector: string) =>
  rules.find((r) => r.file === file && r.selector === selector);

describe('overlay compositing cost (runtime-performance.md REQ-10)', () => {
  it('parsed the stylesheets at all', () => {
    // Guards the guard: a parser that silently matched nothing would make every
    // other assertion here vacuously true.
    expect(rules.length).toBeGreaterThan(200);
  });

  it('declares backdrop-filter nowhere it is not justified', () => {
    const found = rules
      .filter((r) => /(^|[\s;])backdrop-filter\s*:/.test(r.body))
      .map((r) => `${r.file} ${r.selector}`);

    // An exact set match, both directions — a *new* backdrop-filter fails as
    // unexpected, and a stale allowlist entry fails too, so the list cannot rot
    // into a rubber stamp.
    expect([...found].sort()).toEqual([...VIEWPORT_EFFECT_OK].sort());
  });

  it('keeps the modal backdrop a plain dim (regression)', () => {
    // The bug: this one declaration was inherited by every Modal — confirms,
    // the preset manager, export, record-sound, the WiFi pair wizard, About and
    // the AI prompt — plus the start screen, so opening any of them cost the
    // whole app a third of its frame rate.
    const backdrop = find('modal.module.css', '.backdrop')!;
    expect(backdrop.body).not.toMatch(/backdrop-filter/);
    // The dim is what actually separates the card from the faceplate; losing it
    // to a later cleanup would make this pin pass for the wrong reason.
    expect(backdrop.body).toMatch(/background:\s*rgba\(/);
  });

  it('keeps the tour\'s centred step a plain dim (regression)', () => {
    // The second copy, acquired by imitation from the rule above.
    const centered = find('tour.module.css', '.centered')!;
    expect(centered.body).not.toMatch(/backdrop-filter/);
    expect(centered.body).toMatch(/background:\s*rgba\(/);
  });
});
