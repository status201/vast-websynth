/**
 * Puts the cascade layer order at the top of EVERY CSS file the build emits
 * (specs/features/css-cascade-layers.md REQ-the-layer-order-is-declared-once-and-first).
 *
 * Layer order is fixed by whichever stylesheet names the layers first, and in a
 * build that is not `layers.css`. Vite moves a stylesheet that lazy chunks also
 * use (switch, segmented) into a shared CSS chunk and links it BEFORE the entry
 * CSS, so `controls` was named first and became the LOWEST layer — beneath the
 * reset, which then stripped every switch-styled button. The minifier also
 * drops the order statement from the entry CSS, since within that one file it
 * looks redundant.
 *
 * So every stylesheet the build compiles opens with the statement, and every
 * chunk inherits it. The minifier still trims each copy to the layers that
 * chunk needs — but it keeps the PREFIX of the order up to the chunk's highest
 * layer, so the browser only ever learns layers in declared order, whichever
 * chunk it meets first. `scripts/check-bundle.mjs` asserts exactly that on the
 * built files, since it rests on the minifier's behaviour. `vite dev` needs
 * none of this — it links layers.css from index.html ahead of every <style>.
 */
import { readFileSync } from 'node:fs';

/** The `@layer a, b, …;` statement from layers.css, the order's one home. */
export function readLayerStatement(file) {
  const css = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const m = /@layer\s+[^;{]+;/.exec(css);
  if (!m) throw new Error(`${file} declares no @layer order`);
  return m[0].replace(/\s+/g, ' ');
}

export function cssLayerOrderPlugin(layersFile) {
  const statement = readLayerStatement(layersFile);
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
