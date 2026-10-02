/**
 * The cascade layer order (specs/features/css-cascade-layers.md): reading it
 * from its one home, `src/styles/layers.css`, and checking a stylesheet names
 * layers in that order. Shared by the build plugin below, `check-bundle.mjs`,
 * the conflict audit and the unit tests — so "what is the order" has one parser.
 *
 * Why the build needs a plugin at all: layer order is fixed by whichever
 * stylesheet names the layers first, and in a build that is not `layers.css`.
 * Vite moves a stylesheet that lazy chunks also use (switch, segmented) into a
 * shared CSS chunk and links it BEFORE the entry CSS, so `controls` was named
 * first and became the LOWEST layer — beneath the reset, which then stripped
 * every switch-styled button. The minifier also drops the order statement from
 * the entry CSS, since within that one file it looks redundant.
 *
 * So every stylesheet the build compiles opens with the statement, and every
 * chunk inherits it. The minifier still trims each copy to the layers that
 * chunk needs — but it keeps the PREFIX of the order up to the chunk's highest
 * layer, so the browser only ever learns layers in declared order, whichever
 * chunk it meets first. `check-bundle.mjs` asserts exactly that on the built
 * files (`namesLayersInOrder`), since it rests on the minifier's behaviour.
 * `vite dev` needs none of this — it links layers.css from index.html ahead of
 * every <style>.
 */
import { readFileSync } from 'node:fs';

/** `src/styles/layers.css`, wherever the caller runs from. */
export const LAYERS_CSS = new URL('../../src/styles/layers.css', import.meta.url);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The declared order: `{ statement, names }`. Throws unless the file holds
 * exactly one `@layer a, b, …;` statement and nothing else — a second statement
 * or a stray rule would make "the order" ambiguous.
 */
export function readLayerOrder(file = LAYERS_CSS) {
  const css = stripComments(readFileSync(file, 'utf-8'));
  const statements = css.match(/@layer\s+[^;{]+;/g) ?? [];
  if (statements.length !== 1) throw new Error(`${file}: expected one @layer order statement, found ${statements.length}`);
  if (css.replace(statements[0], '').trim() !== '') throw new Error(`${file}: holds more than the @layer order statement`);
  const statement = statements[0].replace(/\s+/g, ' ');
  const names = statement.replace(/^@layer\s+|;$/g, '').split(',').map((s) => s.trim());
  return { statement, names };
}

/** Layer names in order of first mention — `@layer a, b;` statements and `@layer a {` blocks alike. */
export function layersNamedIn(css) {
  const seen = [];
  for (const m of stripComments(css).matchAll(/@layer\s+([\w\s,-]+?)\s*[;{]/g)) {
    for (const name of m[1].split(',').map((s) => s.trim())) if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * True when `css` names its layers as an exact prefix of `order` — the property
 * that makes a chunk safe to load first.
 */
export function namesLayersInOrder(css, order) {
  const seen = layersNamedIn(css);
  return seen.every((name, i) => order[i] === name);
}

/** Vite plugin: prefix every stylesheet the build compiles with the order statement. */
export function cssLayerOrderPlugin(file = LAYERS_CSS) {
  const { statement } = readLayerOrder(file);
  return {
    name: 'css-layer-order',
    apply: 'build',
    enforce: 'pre',
    // At transform time, so the statement is part of each file's content HASH:
    // a reordered layer list must rename the CSS it reorders, or the service
    // worker's cache-first would keep serving the old order under the old name.
    transform(code, id) {
      if (!/\.css(\?|$)/.test(id) || id.includes('?raw')) return null;
      return { code: `${statement}\n${code}`, map: null };
    },
  };
}
