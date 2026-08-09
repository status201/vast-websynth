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
 * It also writes `src/state/demos-index.json` — one `DemoMeta` per demo (name,
 * tempo, length, machines used, what is armed for the player). The demos are
 * **fetched on click**, not bundled (song-mode.md REQ-11), so the app cannot read
 * a song's own fields at build time; this index is how the shelf knows anything
 * about them. Generated here because this is already the one pass that parses
 * every demo, so the index cannot fall out of step with the files it describes
 * (demo-library.md REQ-1).
 *
 * Two things it deliberately does NOT own: the **zip** demos' bytes (a zip is a
 * container — canonicalizing one would churn megabytes for no readable diff; it
 * only reads them for their metadata) and the hand-written **blurbs**, which live
 * in `src/state/demo-notes.json` and are merged in, never rewritten (REQ-2).
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
import { demoMetaOf, type DemoMeta } from '../src/state/demo-meta';
import { parseProjectZip } from '../src/state/project';

const checkOnly = !!process.env['CLEAN_DEMOS_CHECK'];

test(checkOnly ? 'demo song files are canonical' : 'canonicalize demo song files', async () => {
  const stateDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'state');
  const demosDir = join(stateDir, 'demos');
  const drifted: string[] = [];
  const index: Record<string, DemoMeta> = {};

  // Hand-written blurbs, merged in below. Kept in their own file precisely so
  // this generator can never clobber prose (demo-library.md REQ-2), and every
  // entry is optional — a demo with no note is still a pure data drop-in.
  const notesPath = join(stateDir, 'demo-notes.json');
  const notes = existsSync(notesPath)
    ? JSON.parse(readFileSync(notesPath, 'utf8')) as Record<string, string>
    : {};

  const entries = readdirSync(demosDir).sort();

  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const path = join(demosDir, f);
    // CRLF-normalize: .gitattributes pins demos to LF, but a pre-renormalization
    // Windows working copy may still carry CRLF — that alone is not drift.
    const before = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const file = JSON.parse(before) as SongFile;
    index[f] = withBlurb(demoMetaOf(file), notes[f]);
    const json = JSON.stringify(compactSongForExport(file), null, 2) + '\n';
    if (checkOnly) {
      if (json !== before) drifted.push(f);
    } else if (json !== before) {
      writeFileSync(path, json);
      // eslint-disable-next-line no-console
      console.log(`cleaned ${f}: ${before.length} -> ${json.length} bytes`);
    }
  }

  // Project-zip demos (demo-library.md REQ-3). They are the only demos that can
  // use the sampler — a .json cannot embed audio — so leaving them out of the
  // index made the two most feature-complete demos the two least described.
  // Their bytes are NOT canonicalized: a zip is a container, and rewriting one
  // would churn megabytes for no readability gain.
  for (const f of entries) {
    if (!f.endsWith('.websynth.zip')) continue;
    const bytes = new Uint8Array(readFileSync(join(demosDir, f)));
    const parsed = await parseProjectZip(bytes);
    if (!parsed.ok) {
      drifted.push(`${f} (unreadable: ${parsed.errors[0] ?? 'unknown error'})`);
      continue;
    }
    index[f] = withBlurb(demoMetaOf(parsed.file), notes[f]);
  }

  // Keys are the sorted filenames above, so the emitted JSON is stable.
  const indexPath = join(stateDir, 'demos-index.json');
  const sorted: Record<string, DemoMeta> = {};
  for (const k of Object.keys(index).sort()) sorted[k] = index[k]!;
  const json = JSON.stringify(sorted, null, 2) + '\n';
  const currentIndex = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n')
    : '';
  if (checkOnly) {
    if (json !== currentIndex) drifted.push('demos-index.json');
  } else if (json !== currentIndex) {
    writeFileSync(indexPath, json);
    // eslint-disable-next-line no-console
    console.log(`wrote demos-index.json (${Object.keys(sorted).length} demos)`);
  }

  expect(drifted, 'non-canonical demo files — run `npm run clean:demos`').toEqual([]);
});

/** Attach a hand-written blurb, omitting the key entirely when there is none. */
function withBlurb(meta: Omit<DemoMeta, 'blurb'>, blurb: string | undefined): DemoMeta {
  return blurb ? { ...meta, blurb } : meta;
}
