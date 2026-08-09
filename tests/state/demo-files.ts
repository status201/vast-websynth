import type { SongFile } from '../../src/state/song';

/**
 * The drop-in demo songs, keyed by the song's own `name` — what
 * `DEMO_SONGS` used to contain before the app switched to fetching them on
 * click (song-mode.md REQ-11, runtime-performance.md REQ-1).
 *
 * The app must not bundle 835 kB of JSON to load at most one of them; the *test*
 * bundle happily can, and should: these files ship, so "every shipped demo is a
 * valid SongFile" is exactly the guard that must not be lost in the move to lazy
 * loading. Eagerly globbing here keeps that coverage on the real files while the
 * production glob stays `?url`.
 *
 * Deliberately mirrors the old registration rule — sorted by path, keyed by
 * `name` — so the ordering assertions still mean what they meant.
 */
const DROPPED = import.meta.glob<SongFile>('../../src/state/demos/*.json', {
  eager: true,
  import: 'default',
});

export const DROP_IN_DEMOS: Record<string, SongFile> = {};
/**
 * The same names as an **array, in registration order** — which
 * `Object.keys(DROP_IN_DEMOS)` is not. JS hoists integer-like keys to the front
 * of an object regardless of insertion order, and several demos are named for a
 * year — a bare four-digit string is an integer-like key — so a demo whose
 * filename sorts ahead of those still lands *after* them in `Object.keys`. Any
 * order-sensitive assertion must use this array instead.
 */
export const DROP_IN_NAMES: string[] = [];
for (const path of Object.keys(DROPPED).sort()) {
  const song = DROPPED[path]!;
  DROP_IN_DEMOS[song.name] = song;
  DROP_IN_NAMES.push(song.name);
}

/** Filenames in the same sorted order, for index/label assertions. */
export const DROP_IN_FILENAMES: string[] = Object.keys(DROPPED)
  .sort()
  .map((p) => p.replace(/^.*\//, ''));

/**
 * The first drop-in that explicitly declares every listed param key — for a test
 * that must pin a param *value* without naming a demo.
 *
 * A canonically-exported demo carries its whole `params` map (only step cells go
 * sparse — ADR-011), but `add-a-demo-song.md` allows a hand-authored partial
 * file, so "some demo states this key" is an assumption worth checking rather
 * than assuming. Throws naming the missing key: never a silent skip.
 */
export function dropInDeclaring(...keys: string[]): { name: string; song: SongFile } {
  for (const [name, song] of Object.entries(DROP_IN_DEMOS)) {
    if (keys.every((k) => typeof song.params[k] === 'number')) return { name, song };
  }
  throw new Error(
    `no drop-in demo declares ${keys.join(' + ')} — either a demo lost the key, or `
    + 'the assertion needs a different one (tests/state/demo-files.ts)',
  );
}
