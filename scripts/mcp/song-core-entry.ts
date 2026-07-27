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
// The canonical version, from the import-free module (never from `song.ts`), so
// server-side text can cite it instead of hardcoding a literal that goes stale.
export { SONG_VERSION, KNOWN_SONG_VERSIONS } from '../../src/state/song-version';
export { isAuthorSong, expandAuthorSong, AUTHOR_FORMAT } from '../../src/state/song-author';
export { compactSongForExport } from '../../src/state/serialize';
export { buildAuthoringGuide, buildSongPrompt, buildPresetGuide } from '../../src/state/authoring-guide';
export { ParamBus, registerDefaults } from '../../src/state/params';
// Presets are the other half of what the synth stores (preset-authoring.md).
// The subtree is preset-validate → preset-session (pure) and preset-file →
// serialize; `preset.ts` itself is never pulled in (localStorage), only its
// `Snapshot` type, which erases.
export {
  validatePresetPayload,
  expandPresetParams,
  defaultPatchParams,
  PRESET_FORMAT,
  BANK_FORMAT,
} from '../../src/state/preset-validate';
export type { PresetParse, PresetFile, PresetBankFile } from '../../src/state/preset-validate';
export {
  buildPresetFile,
  buildBankFile,
  presetFilename,
  bankFilename,
} from '../../src/state/preset-file';
export {
  SEQ_LENGTH,
  BANK_COUNT,
  DRUM_TRACK_COUNT,
  SAMPLER_SLOT_COUNT,
} from '../../src/state/patterns';
