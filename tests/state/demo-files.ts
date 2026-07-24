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
for (const path of Object.keys(DROPPED).sort()) {
  const song = DROPPED[path]!;
  DROP_IN_DEMOS[song.name] = song;
}

/** Filenames in the same sorted order, for index/label assertions. */
export const DROP_IN_FILENAMES: string[] = Object.keys(DROPPED)
  .sort()
  .map((p) => p.replace(/^.*\//, ''));
