import { readSource } from './css-source';

/**
 * The themes' tokens, read from the stylesheets as text (specs/features/ui-themes.md).
 * One parser for every theme test, so "what does theme X say --y is" has one answer.
 * Dark is `theme.css`'s `:root`; every other theme is the `:root[data-theme="<id>"]`
 * block of `src/styles/themes/<id>.css`.
 */

/** A stylesheet's text with its comments removed. */
export const cssText = (file: string): string => readSource(file).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * `--name: value` from every brace-free block whose selector matches. A dumb
 * parser, like typography.test.ts: only innermost blocks match, so an `@layer`
 * wrapper is seen through.
 */
export function blockTokens(css: string, selector: RegExp): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.test(b[1]!.trim())) continue;
    for (const t of b[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(t[1]!, t[2]!.trim());
  }
  return map;
}

/** Dark's tokens: `theme.css`'s `:root`, every token's own declaration. */
export const rootTokens = (): Map<string, string> => blockTokens(cssText('src/styles/theme.css'), /^:root$/);

/** What a theme's own block declares — for Dark, the whole of `:root`. */
export function themeTokens(id: string): Map<string, string> {
  if (id === 'dark') return rootTokens();
  return blockTokens(cssText(`src/styles/themes/${id}.css`), new RegExp(`^:root\\[data-theme=["']${id}["']\\]$`));
}

/**
 * What a token computes to in a theme: its own block over Dark's `:root`, with a
 * `var()` chain followed — so a derived token (`--playing: var(--accent-secondary)`)
 * is read as the colour the theme actually gives it. '' when undeclared.
 */
export function resolvedToken(id: string, token: string): string {
  const tokens = new Map([...rootTokens(), ...(id === 'dark' ? [] : themeTokens(id))]);
  let v = tokens.get(token);
  for (let i = 0; v && i < 10; i++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (!m) break;
    v = tokens.get(m[1]!);
  }
  return v ?? '';
}
