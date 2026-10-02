#!/usr/bin/env node
/**
 * The boot-payload gate (runtime-performance.md REQ-boot-cost-matches-the-request):
 * the entry chunk `dist/assets/index-*.js` stays under Vite's 500 kB warning
 * threshold. The warning alone is only seen by whoever reads the build output;
 * this turns it into a failing check. Run after `npm run build`.
 *
 * A failure means something joined the boot path — find what, and defer it
 * behind an `import()` (see the REQ) rather than raising the ceiling.
 *
 * It also checks the built CSS names its cascade layers in declared order —
 * see the second half of this file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { layersNamedIn, namesLayersInOrder, readLayerOrder } from './lib/css-layer-order.mjs';

/** Vite's `chunkSizeWarningLimit` default, in its own unit (1 kB = 1000 bytes). */
const ENTRY_CEILING_BYTES = 500_000;
const ASSETS = 'dist/assets';

let names;
try {
  names = readdirSync(ASSETS);
} catch {
  console.error(`check-bundle: no ${ASSETS}/ — run \`npm run build\` first.`);
  process.exit(1);
}

const entries = names.filter((n) => /^index-[\w-]+\.js$/.test(n));
if (entries.length !== 1) {
  console.error(`check-bundle: expected one entry chunk index-*.js in ${ASSETS}/, found ${entries.length}`
    + (entries.length ? ` (${entries.join(', ')}) — stale files from an earlier build?` : '.'));
  process.exit(1);
}

const entry = entries[0];
const bytes = statSync(join(ASSETS, entry)).size;
const kb = (n) => `${(n / 1000).toFixed(2)} kB`;
if (bytes > ENTRY_CEILING_BYTES) {
  console.error(`check-bundle: entry chunk ${entry} is ${bytes} bytes, over the ${ENTRY_CEILING_BYTES}-byte ceiling.`);
  console.error('Something joined the boot path — defer it behind an import() (runtime-performance.md REQ-boot-cost-matches-the-request).');
  process.exit(1);
}
console.log(`check-bundle: entry chunk ${entry} is ${kb(bytes)} (${kb(ENTRY_CEILING_BYTES - bytes)} headroom).`);

/**
 * The cascade layer order (css-cascade-layers.md REQ-the-layer-order-is-declared-once-and-first).
 * A browser fixes the order from the first stylesheet that names a layer, and
 * the build splits CSS into chunks that load in an order nobody chose. So every
 * CSS chunk must name its layers as an exact PREFIX of the declared order —
 * then whichever chunk loads first, layers are only ever learnt in that order.
 * `css-layer-order.mjs` arranges it; the minifier trims each copy; this checks
 * what actually shipped.
 */
const { names: order } = readLayerOrder();
let layerFailures = 0;
for (const css of names.filter((n) => n.endsWith('.css'))) {
  const text = readFileSync(join(ASSETS, css), 'utf-8');
  if (!namesLayersInOrder(text, order)) {
    console.error(`check-bundle: ${css} names its layers as [${layersNamedIn(text).join(', ')}], not a prefix of [${order.join(', ')}].`);
    layerFailures++;
  }
}
if (layerFailures) process.exit(1);
console.log(`check-bundle: every CSS chunk names its layers in declared order (${order.length} layers).`);
