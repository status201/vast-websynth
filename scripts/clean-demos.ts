/**
 * Repeatable canonicalizer for the committed demo songs, and the generator for
 * their name index. Run: `npm run clean:demos`.
 *
 * Rewrites every `src/state/demos/*.json` through `compactSongForExport` — the
 * exact helper the app exports with (DRY) — pretty-printed so git diffs stay
 * readable while default cells collapse to `{ "on": false }` and floats drop to
 * 4 significant figures. Sound-preserving: rounding is inaudible and sparse cells
 * re-expand on load (see ADR-011).
 *
 * It also writes `src/state/demos-index.json` — `filename → song name` for every
 * drop-in. The demos are **fetched on click**, not bundled (song-mode.md REQ-11),
 * so the app can no longer read a song's own `name` field at build time; this
 * index is how the demo buttons keep their exact labels. Generated here because
 * this is already the one pass that parses every demo, so the index cannot fall
 * out of step with the files it describes.
 *
 * With `CLEAN_DEMOS_CHECK` set (injected by `scripts/check-demos.config.ts`,
 * `npm run check:demos`) it writes nothing and instead fails listing every file
 * that isn't byte-identical to its canonical form — the CI drift gate. The index
 * is checked the same way, so a renamed demo cannot ship with a stale label.
 *
 * It is a vitest entry (driven by `scripts/clean-demos.config.ts`, NOT part of
 * `npm test`, which only globs `tests/**`) because vitest is the only Vite-aware
 * TS runner in the toolchain — plain Node cannot resolve the codebase's
 * extensionless relative imports.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import type { SongFile } from '../src/state/song';
import { compactSongForExport } from '../src/state/serialize';

const checkOnly = !!process.env['CLEAN_DEMOS_CHECK'];

test(checkOnly ? 'demo song files are canonical' : 'canonicalize demo song files', () => {
  const stateDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'state');
  const demosDir = join(stateDir, 'demos');
  const drifted: string[] = [];
  const names: Record<string, string> = {};
  for (const f of readdirSync(demosDir).sort()) {
    if (!f.endsWith('.json')) continue;
    const path = join(demosDir, f);
    // CRLF-normalize: .gitattributes pins demos to LF, but a pre-renormalization
    // Windows working copy may still carry CRLF — that alone is not drift.
    const before = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const file = JSON.parse(before) as SongFile;
    names[f] = file.name;
    const json = JSON.stringify(compactSongForExport(file), null, 2) + '\n';
    if (checkOnly) {
      if (json !== before) drifted.push(f);
    } else if (json !== before) {
      writeFileSync(path, json);
      // eslint-disable-next-line no-console
      console.log(`cleaned ${f}: ${before.length} -> ${json.length} bytes`);
    }
  }

  // Keys are the sorted filenames above, so the emitted JSON is stable.
  const indexPath = join(stateDir, 'demos-index.json');
  const index = JSON.stringify(names, null, 2) + '\n';
  const currentIndex = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n')
    : '';
  if (checkOnly) {
    if (index !== currentIndex) drifted.push('demos-index.json');
  } else if (index !== currentIndex) {
    writeFileSync(indexPath, index);
    // eslint-disable-next-line no-console
    console.log(`wrote demos-index.json (${Object.keys(names).length} demos)`);
  }

  expect(drifted, 'non-canonical demo files — run `npm run clean:demos`').toEqual([]);
});
