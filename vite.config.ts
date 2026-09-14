/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { offlineManifestPlugin } from './scripts/lib/offline-manifest.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  root: '.',
  publicDir: 'public',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Writes dist/offline-manifest.json — every file the app can request, for the
  // About card's Play offline and the worker's release refresh
  // (specs/features/play-offline.md REQ-2).
  plugins: [offlineManifestPlugin(pkg.version)],
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        // The drop-in demo songs (src/state/demos/*.json) used to be imported
        // eagerly and needed a chunk of their own — ~227 kB of JS (835 kB of
        // JSON) downloaded and evaluated by every visitor to load at most one.
        // They are now `?url` assets fetched on click (song-mode.md REQ-11), so
        // no bundling rule applies to them at all; the JSON lands in
        // dist/assets/ as plain files.
        codeSplitting: {
          groups: [
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
    // Tests live outside `src/` so `tsc` / `npm run typecheck` are unaffected
    // (tsconfig include is `src` only).
    //
    // **A DOM is opt-in.** Building a jsdom environment costs ~0.9 s, and it
    // used to be built for all 197 files — 88% of the suite's tracked time —
    // when only 108 of them ever touch a `document`. Measured on 2026-09-09:
    // the 89 DOM-free files ran in 81.5 s under jsdom and 19.9 s under node,
    // unchanged, and the whole suite went from 163.8 s to ~100 s.
    //
    // So `tests/ui/**` gets jsdom by its directory (every file there is a
    // component test), and everything else gets `node` unless it asks for a
    // DOM with a `// @vitest-environment jsdom` docblock on line 1 — which 31
    // files under `tests/audio` and `tests/state` do, mostly for `window`
    // listeners, `Audio` elements, `navigator` or `localStorage`.
    //
    // The default is `node` rather than `jsdom` deliberately: a new DOM test
    // that forgets the docblock fails immediately on `document is not defined`,
    // whereas the other way round a new pure test silently costs a second
    // forever. Loud beats cheap.
    //
    // Vitest's own suggestions in that hint — `pool: 'vmThreads'` and
    // `isolate: false` — were both measured here and both BREAK this suite.
    // `isolate: false` is the instructive one: `tests/audio/effects/fx-cost.test.ts`
    // asserts the reverb IR bank is built cold, and that cache is deliberately
    // process-wide (features/effects.md REQ-6), as are the drive-curve and PWM
    // wave-table caches. Sharing an environment across files makes every such
    // cache a cross-file leak. Don't take that trade.
    projects: [
      {
        extends: true,
        test: {
          name: 'ui',
          include: ['tests/ui/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/ui/**'],
          environment: 'node',
        },
      },
    ],
  },
});
