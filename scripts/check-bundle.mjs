#!/usr/bin/env node
/**
 * The boot-payload gate (runtime-performance.md REQ-boot-cost-matches-the-request):
 * the entry chunk `dist/assets/index-*.js` stays under Vite's 500 kB warning
 * threshold. The warning alone is only seen by whoever reads the build output;
 * this turns it into a failing check. Run after `npm run build`.
 *
 * A failure means something joined the boot path — find what, and defer it
 * behind an `import()` (see the REQ) rather than raising the ceiling.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
