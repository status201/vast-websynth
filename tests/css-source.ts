import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Stylesheets read as text. Vitest never resolves a CSS Module to real CSS —
 * `styles.root` is just a string there — so a claim about what a rule declares
 * can only be pinned from the source (the same reason typography.test.ts reads it).
 */
export const readSource = (file: string): string =>
  readFileSync(resolve(process.cwd(), file), 'utf8');

/**
 * The declared value of one property inside one rule, or null. Deliberately
 * string surgery rather than a built regex: selectors like `.page` / `.pageShell`
 * and `.bottom` / `.bottomTop` share prefixes, and matching on `<selector> {`
 * keeps them apart without any escaping to get wrong.
 */
export function cssDecl(css: string, selector: string, prop: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  const body = css.slice(at, css.indexOf('}', at));
  for (const line of body.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    if (line.slice(0, i).trim() !== prop) continue;
    return line.slice(i + 1).replace(';', '').trim();
  }
  return null;
}

/** One top-level rule of an app stylesheet. */
export interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** The app's stylesheet folders: the modules and the global sheets. */
const STYLE_DIRS = ['src/ui/styles', 'src/styles'];

/**
 * Every rule in the app's stylesheets, file by file in name order. Deliberately
 * a dumb parser — a drift pin, not a CSS engine. Comments are stripped, and an
 * `@media` / `@layer` wrapper is skipped over rather than parsed (its inner rules
 * still match, since only innermost brace-free blocks can). One parser for every
 * pin, so two of them cannot disagree about what a rule is.
 *
 * With `splitSelectors`, a selector list `a, b { … }` yields one rule per
 * selector.
 */
export function readRules({ splitSelectors = false } = {}): Rule[] {
  const rules: Rule[] = [];
  for (const dir of STYLE_DIRS) {
    const path = resolve(process.cwd(), dir);
    for (const file of readdirSync(path).filter((n) => n.endsWith('.css')).sort()) {
      const css = readFileSync(resolve(path, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = splitSelectors ? m[1]!.split(',') : [m[1]!];
        for (const selector of selectors) {
          const s = selector.trim().replace(/\s+/g, ' ');
          if (s) rules.push({ file, selector: s, body: m[2]! });
        }
      }
    }
  }
  return rules;
}
