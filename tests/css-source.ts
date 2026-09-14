import { readFileSync } from 'node:fs';
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
