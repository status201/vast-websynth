/**
 * The song format's version, alone in its own module.
 *
 * Deliberately **pure and import-free**: `authoring-guide.ts` and the MCP
 * server's Node bundle both need the number, and neither may import `song.ts`,
 * whose `import.meta.glob` demo registration would come along for the ride
 * (song-authoring-dialect.md REQ-10). `song.ts` re-exports `SONG_VERSION`, so
 * every existing importer is unaffected.
 *
 * Why it lives here rather than as a literal at each site: the published docs
 * (`public/schema/websynth-song.schema.json`, `public/llms.txt`, the authoring
 * guide the MCP `get_song_format` tool serves) advertise the version to external
 * tools, and they fell a version behind twice before
 * `tests/state/authoring-docs.test.ts` pinned them to this constant
 * (song-mode.md REQ-2). See `specs/recipes/evolve-the-song-format.md`.
 */

/** The version `Song.capture()` writes. Bumping the format starts here. */
export const SONG_VERSION = 6;

/**
 * Every version this build loads, oldest first. Versioning is additive — each
 * bump only adds optional fields (ADR-007) — so the set is always
 * `1..SONG_VERSION` and derives rather than being maintained by hand.
 */
export const KNOWN_SONG_VERSIONS: number[] =
  Array.from({ length: SONG_VERSION }, (_, i) => i + 1);
