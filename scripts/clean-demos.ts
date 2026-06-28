/**
 * Repeatable canonicalizer for the committed demo songs. Run: `npm run clean:demos`.
 *
 * Rewrites every `src/state/demos/*.json` through `compactSongForExport` — the
 * exact helper the app exports with (DRY) — pretty-printed so git diffs stay
 * readable while default cells collapse to `{ "on": false }` and floats drop to
 * 4 significant figures. Sound-preserving: rounding is inaudible and sparse cells
 * re-expand on load (see ADR-011).
 *
 * It is a vitest entry (driven by `scripts/clean-demos.config.ts`, NOT part of
 * `npm test`, which only globs `tests/**`) because vitest is the only Vite-aware
 * TS runner in the toolchain — plain Node cannot resolve the codebase's
 * extensionless relative imports.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import type { SongFile } from '../src/state/song';
import { compactSongForExport } from '../src/state/serialize';

test('canonicalize demo song files', () => {
  const demosDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'state', 'demos');
  for (const f of readdirSync(demosDir)) {
    if (!f.endsWith('.json')) continue;
    const path = join(demosDir, f);
    const file = JSON.parse(readFileSync(path, 'utf8')) as SongFile;
    const before = readFileSync(path, 'utf8').length;
    const json = JSON.stringify(compactSongForExport(file), null, 2) + '\n';
    writeFileSync(path, json);
    // eslint-disable-next-line no-console
    console.log(`cleaned ${f}: ${before} -> ${json.length} bytes`);
  }
});
