/**
 * The boot-side half of the authoring dialect: how to *recognise* an author
 * file, without the expander that turns it into a canonical `SongFile`.
 * `Song.parse` routes on `isAuthorSong` and `import()`s `song-author.ts` only
 * when it holds, so the ~15 kB expander stays off the boot path
 * (song-authoring-dialect.md REQ-the-expander-loads-with-the-first-author-file).
 * `song-author.ts` re-exports all three names.
 */
import { isObject } from './validate-utils';

export const AUTHOR_FORMAT = 'websynth-song-author';
/** The one author-dialect version (param-catalogue.md — named, like `SONG_VERSION`). */
export const AUTHOR_VERSION = 1;

/** `format === 'websynth-song-author'` on a JSON object — the routing test used by `Song.parse`. */
export function isAuthorSong(value: unknown): boolean {
  return isObject(value) && value.format === AUTHOR_FORMAT;
}
