// @vitest-environment node
//
// Drift pin for the cascade layers (specs/features/css-cascade-layers.md).
//
// Which stylesheet wins between two that style one element is decided by the
// layer order in `src/styles/layers.css` — never by import order, which is what
// broke the first attempt to split `ui/app.ts`. That only holds while EVERY
// sheet is layered: an unlayered rule beats every layered one whatever its
// specificity, so a single forgotten file would silently outrank the whole app.
// Nothing else can see that — `sdd-guard` exempts CSS and jsdom never resolves
// a CSS Module — so this reads the stylesheets as text.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declared order, from the one statement in layers.css. */
function declaredLayers(): string[] {
  const css = stripComments(readFileSync(root('src/styles/layers.css'), 'utf8'));
  const statements = [...css.matchAll(/@layer\s+([^;{]+);/g)];
  expect(statements, 'layers.css declares the order exactly once').toHaveLength(1);
  expect(css.replace(/@layer\s+[^;{]+;/, '').trim(), 'layers.css holds nothing but the order').toBe('');
  return statements[0]![1]!.split(',').map((s) => s.trim());
}

/** Every stylesheet the app ships except layers.css itself, repo-relative. */
function stylesheets(): string[] {
  const out: string[] = [];
  for (const dir of ['src/styles', 'src/ui/styles']) {
    for (const f of readdirSync(root(dir)).sort()) {
      if (f.endsWith('.css') && !(dir === 'src/styles' && f === 'layers.css')) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

/**
 * The layer a sheet's rules all live in, or why it has none: the whole file,
 * comments aside, must be ONE `@layer name { … }` block — its opening brace's
 * match must be the file's last character, so no rule sits before or after it.
 */
function layerOf(css: string): string {
  const body = stripComments(css).trim();
  const head = /^@layer\s+([\w-]+)\s*\{/.exec(body);
  if (!head) return 'no @layer block at the top';
  let depth = 0;
  for (let i = head[0].length - 1; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      return i === body.length - 1 ? head[1]! : 'rules outside the @layer block';
    }
  }
  return 'unbalanced braces';
}

describe('cascade layers (specs/features/css-cascade-layers.md)', () => {
  const layers = declaredLayers();
  const sheets = stylesheets();

  it('found the stylesheets at all', () => {
    // Guards the guard: an empty list would make the next test vacuously true.
    expect(sheets.length).toBeGreaterThan(50);
  });

  it('puts every rule of every stylesheet in one declared layer (REQ-every-stylesheet-declares-its-layer)', () => {
    const wrong = sheets
      .map((s) => [s, layerOf(readFileSync(root(s), 'utf8'))] as const)
      .filter(([, layer]) => !layers.includes(layer))
      .map(([s, layer]) => `${s}: ${layer}`);
    expect(wrong).toEqual([]);
  });

  it('loads layers.css before any other stylesheet (REQ-the-layer-order-is-declared-once-and-first)', () => {
    const html = readFileSync(root('index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const firstSheet = /<(?:link[^>]+rel="stylesheet"[^>]*|style\b[^>]*)>/.exec(html)?.[0] ?? '';
    expect(firstSheet).toContain('href="/src/styles/layers.css"');
  });

  it('keeps the global sheets beneath every module (REQ-a-composer-outranks-what-it-composes)', () => {
    // The reset, the tokens and the .app grid are what every component builds
    // on; layered above one, a global element rule would override it.
    const globals = ['src/styles/base.css', 'src/styles/theme.css', 'src/styles/layout.css'];
    const highestGlobal = Math.max(...globals.map((g) => layers.indexOf(layerOf(readFileSync(root(g), 'utf8')))));
    const lowestModule = Math.min(...sheets
      .filter((s) => s.startsWith('src/ui/styles/'))
      .map((s) => layers.indexOf(layerOf(readFileSync(root(s), 'utf8')))));
    expect(highestGlobal).toBeLessThan(lowestModule);
  });
});
