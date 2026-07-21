/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  root: '.',
  publicDir: 'public',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        // The drop-in demo songs (src/state/demos/*.json) are full song
        // exports — ~700 kB of JSON eagerly pulled in by the import.meta.glob
        // in state/song.ts. Inlined into the entry chunk they pushed it past
        // Vite's 500 kB warning. Split them into their own `demos` chunk so the
        // app code and the (rarely-changing) demo data are bundled and cached
        // separately. New JSON dropped into demos/ is absorbed automatically.
        codeSplitting: {
          groups: [
            { name: 'demos', test: /[\\/]state[\\/]demos[\\/].*\.json$/ },
            // The vendored lamejs MP3 encoder is 153 kB of pre-minified JS —
            // 30% of what used to be a single 505 kB entry chunk, downloaded by
            // every visitor whether or not they ever export MP3. It is reached
            // only through the dynamic import in `encodeMp3`, so rolldown
            // already splits it; this just gives the chunk a stable, readable
            // name. See specs/features/audio-export.md REQ-7.
            { name: 'lamejs', test: /[\\/]vendor[\\/]lamejs[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
  test: {
    // jsdom for the DOM-coupled component tests; pure-logic suites run
    // fine under it too. Tests live outside `src/` so `tsc`/`npm run
    // typecheck` are unaffected (tsconfig include is `src` only).
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
