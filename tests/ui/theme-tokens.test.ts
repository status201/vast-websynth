// @vitest-environment node
//
// Drift pin for the theme tokens (specs/features/ui-themes.md).
//
// A theme can only recolour what goes through a token. Before this pin, ~340
// colour literals had been copied into the CSS Modules — mostly the palette by
// hand — so a theme would have left islands of the default amber behind. CSS is
// exempt from sdd-guard and the jsdom suite never resolves a module to real CSS,
// so, like tests/ui/typography.test.ts, this reads the stylesheets as text.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MODULES = path.join(ROOT, 'src/ui/styles');
const GLOBALS = path.join(ROOT, 'src/styles');
const THEMES = path.join(GLOBALS, 'themes');
const THEME = path.join(GLOBALS, 'theme.css');

const read = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const cssIn = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.css')).sort().map((n) => path.join(dir, n)) : [];

/** Every stylesheet a token rule governs: the modules and the global sheets, minus the token owners. */
const governed = [...cssIn(MODULES), ...cssIn(GLOBALS).filter((f) => f !== THEME)];

/** The <noscript> page renders before any theme exists (REQ-every-colour-is-a-token). */
const LITERAL_SELECTORS = new Set(['base.css .noscript-page', 'base.css .noscript-link']);

interface Decl { where: string; prop: string; value: string }

/** Every declaration value with its file and innermost selector. A dumb parser, like typography.test.ts:
 *  only brace-free blocks match, so an @media/@layer wrapper is seen through. */
function declarations(file: string): Decl[] {
  const out: Decl[] = [];
  for (const m of read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim().replace(/\s+/g, ' ');
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      out.push({ where: `${path.basename(file)} ${selector}`, prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() });
    }
  }
  return out;
}

const NEUTRAL = /^rgba\(\s*(0,\s*0,\s*0|255,\s*255,\s*255),\s*[\d.]+\s*\)$/;
const NAMED = /\b(white|black|red|green|blue|yellow|orange|gr[ae]y|purple|pink|brown)\b/;

/** The colour literals in one declaration value that REQ-every-colour-is-a-token forbids. */
function forbidden(value: string): string[] {
  const hits = [...value.matchAll(/#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/g)].map((m) => m[0]);
  const named = NAMED.exec(value.replace(/var\([^)]*\)/g, ''));
  return [...hits.filter((h) => !NEUTRAL.test(h)), ...(named ? [named[0]] : [])];
}

/** `--name: value` declarations in a :root-ish block of a theme file. */
function tokens(file: string, selector: RegExp): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.test(m[1]!.trim())) continue;
    for (const t of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(t[1]!, t[2]!.trim());
  }
  return map;
}

const allTs = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? allTs(p) : n.endsWith('.ts') ? [p] : [];
  });

describe('theme tokens (specs/features/ui-themes.md)', () => {
  const decls = governed.flatMap(declarations);
  const root = tokens(THEME, /^:root$/);

  it('parsed the stylesheets at all', () => {
    // Guards the guard: a parser that matched nothing would pass everything.
    expect(governed.length).toBeGreaterThan(40);
    expect(decls.length).toBeGreaterThan(2000);
    expect(root.size).toBeGreaterThan(80);
  });

  it('colours only through tokens (REQ-every-colour-is-a-token)', () => {
    const bad = decls
      .filter((d) => !LITERAL_SELECTORS.has(d.where))
      .flatMap((d) => forbidden(d.value).map((lit) => `${d.where}: ${lit}`));
    expect(bad).toEqual([]);
  });

  it('accepts neutral shadow and shine, and rejects a palette literal (REQ-every-colour-is-a-token)', () => {
    // The checker itself, so a regex slip cannot make the pin above vacuous.
    expect(forbidden('0 1px 2px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06)')).toEqual([]);
    expect(forbidden('color-mix(in srgb, var(--accent) 18%, transparent)')).toEqual([]);
    expect(forbidden('#e2705a')).toEqual(['#e2705a']);
    expect(forbidden('0 0 8px rgba(244, 205, 94, 0.5)')).toEqual(['rgba(244, 205, 94, 0.5)']);
    expect(forbidden('1px solid white')).toEqual(['white']);
  });

  it('reads only tokens that exist (edge, REQ-every-colour-is-a-token)', () => {
    // A typo'd var(--wel-top) silently computes to nothing — a colour vanishes
    // rather than failing. Declared = any `--x:` in a stylesheet, or a name the
    // TS sets at runtime (`style.setProperty('--x', …)`).
    const declared = new Set<string>();
    for (const f of [THEME, ...cssIn(THEMES), ...governed]) {
      for (const m of read(f).matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]!);
    }
    for (const f of allTs(path.join(ROOT, 'src'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"`](--[\w-]+)['"`]/g)) declared.add(m[1]!);
    }
    const missing = new Set<string>();
    for (const d of decls) {
      // A var() with a fallback is allowed to be unset; that is what the fallback is for.
      for (const m of d.value.matchAll(/var\((--[\w-]+)\s*\)/g)) {
        if (!declared.has(m[1]!)) missing.add(`${d.where}: ${m[1]}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('gives every theme every base token (REQ-every-theme-defines-every-token)', () => {
    // A base token holds a colour (or a face) of its own; a derived one
    // (`var(...)` inside) follows its base and is declared once, on :root. The
    // sizing tokens and --mono are not a theme's to set.
    const base = [...root]
      .filter(([k, v]) => !v.includes('var(') && !/^[\d.]+px\b/.test(v) && k !== '--mono')
      .map(([k]) => k)
      .sort();
    expect(base).toContain('--serif');
    expect(base).toContain('--well-top');
    for (const file of cssIn(THEMES)) {
      const id = path.basename(file, '.css');
      const theme = tokens(file, new RegExp(`^:root\\[data-theme=["']${id}["']\\]$`));
      expect(theme.size, `${id}.css declares no :root[data-theme="${id}"] block`).toBeGreaterThan(0);
      expect(base.filter((k) => !theme.has(k)), `${id}.css is missing`).toEqual([]);
    }
  });

  it('keeps --mono out of every theme (REQ-mono-is-not-themed)', () => {
    for (const file of cssIn(THEMES)) expect(read(file)).not.toMatch(/--mono\s*:/);
  });

  it('lets the content face follow the theme (REQ-a-theme-is-a-palette-and-two-faces)', () => {
    const body = declarations(path.join(GLOBALS, 'base.css')).filter((d) => d.where === 'base.css html, body');
    expect(body.find((d) => d.prop === 'font-family')?.value).toBe('var(--sans)');
  });
});
