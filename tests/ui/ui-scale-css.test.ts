// The stylesheet rules the UI scale's zoom engine depends on (specs/features/ui-scale.md).
// Read as text: Vitest never resolves a CSS Module to real CSS.
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { readSource } from '../css-source';

const DIRS = ['src/styles', 'src/styles/themes', 'src/ui/styles'];
const sheets = DIRS.flatMap((d) =>
  readdirSync(path.resolve(process.cwd(), d))
    .filter((f) => f.endsWith('.css'))
    .map((f) => ({ file: `${d}/${f}`, css: readSource(`${d}/${f}`).replace(/\/\*[\s\S]*?\*\//g, '') })),
);

/** The body of every `@container viewport (…) { … }` block, braces balanced. */
function containerBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /@container\s+viewport\b[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(start, i - 1));
  }
  return out;
}

describe('breakpoints follow the effective width (REQ-breakpoints-follow-the-effective-width)', () => {
  it('found the stylesheets', () => {
    expect(sheets.length).toBeGreaterThan(20);
  });

  it('makes <html> the `viewport` inline-size container', () => {
    const base = readSource('src/styles/base.css');
    expect(base).toMatch(/html\s*\{[^}]*container:\s*viewport\s*\/\s*inline-size/);
  });

  it('writes no width or height breakpoint as a media query', () => {
    const offenders = sheets.flatMap(({ file, css }) =>
      [...css.matchAll(/@media[^{]*/g)].map((m) => m[0].trim()).filter((q) => /\b(min-|max-)?(width|height)\b/.test(q)).map((q) => `${file}: ${q}`),
    );
    expect(offenders).toEqual([]);
  });

  it('uses the breakpoints at all (the swap happened, not a deletion)', () => {
    const n = sheets.reduce((acc, { css }) => acc + containerBlocks(css).length, 0);
    expect(n).toBeGreaterThan(20);
  });

  it('never targets html or :root inside a breakpoint — a container query cannot style its container', () => {
    const offenders = sheets.flatMap(({ file, css }) =>
      containerBlocks(css)
        .flatMap((body) => [...body.matchAll(/(^|[},;\s])(html|:root)\b[^{;]*\{/g)].map((m) => `${file}: ${m[0].trim()}`)),
    );
    expect(offenders).toEqual([]);
  });
});

describe('viewport units are divided by the zoom (REQ-viewport-units-are-divided-by-the-zoom)', () => {
  it('writes every screen-sized vw/vh/dvh as calc(… / var(--ui-zoom, 1)), or as a var() fallback', () => {
    const offenders: string[] = [];
    for (const { file, css } of sheets) {
      for (const line of css.split('\n')) {
        if (!/\b\d+(\.\d+)?(d|s|l)?v[wh]\b/.test(line)) continue;
        const divided = /calc\(\s*\d+(\.\d+)?(d|s|l)?v[wh]\s*\/\s*var\(--ui-zoom,\s*1\)\s*\)/g;
        const fallback = /var\(--[\w-]+,\s*\d+(\.\d+)?(d|s|l)?v[wh]\s*\)/g;
        const rest = line.replace(divided, '').replace(fallback, '');
        if (/\b\d+(\.\d+)?(d|s|l)?v[wh]\b/.test(rest)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
