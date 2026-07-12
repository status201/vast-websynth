/**
 * Entry for the MCP server's Node bundle of the *pure* song core
 * (mcp-server.md REQ-4). Built by `npm run build:mcp` (or the server's
 * self-build) into `scripts/mcp/dist/song-core.mjs` via Vite lib mode, because
 * `src/**` can't run under plain Node (extensionless TS imports).
 *
 * Everything re-exported here must stay pure: no DOM, no AudioContext, and —
 * critically — no transitive import of `src/state/song.ts`, whose
 * `import.meta.glob` demo registration doesn't bundle for Node. The subtree
 * is params → patterns → utils/array plus the validators/guide.
 */
export { validateSongFile } from '../../src/state/song-validate';
export type { SongValidation } from '../../src/state/song-validate';
export { isAuthorSong, expandAuthorSong, AUTHOR_FORMAT } from '../../src/state/song-author';
export { compactSongForExport } from '../../src/state/serialize';
export { buildAuthoringGuide, buildSongPrompt } from '../../src/state/authoring-guide';
export { ParamBus, registerDefaults } from '../../src/state/params';
export {
  SEQ_LENGTH,
  BANK_COUNT,
  DRUM_TRACK_COUNT,
  SAMPLER_SLOT_COUNT,
} from '../../src/state/patterns';
