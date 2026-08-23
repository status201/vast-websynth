// The song core, assembled from the real `src/` modules.
//
// `makeTools` takes the core INJECTED (mcp-server.md REQ-5), which is what lets
// the tool suites run against the actual source rather than the Vite lib bundle
// — no build step, and a broken export shows up as a failing test instead of a
// stale `dist/`. This file exists so the two suites that need it
// (tools.test.ts, http.test.ts) assemble it once: a second copy would drift the
// moment `song-core-entry.ts` gains an export, and the drift would look like a
// tool bug.
//
// Keep it in step with `scripts/mcp/song-core-entry.ts` — that is the list the
// bundle actually ships.
import { validateSongFile } from '../../src/state/song-validate';
import { isAuthorSong, expandAuthorSong } from '../../src/state/song-author';
import { compactSongForExport } from '../../src/state/serialize';
import { buildAuthoringGuide, buildSongPrompt, buildPresetGuide } from '../../src/state/authoring-guide';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { validatePresetPayload, expandPresetParams } from '../../src/state/preset-validate';
import { buildPresetFile, buildBankFile, presetFilename, bankFilename } from '../../src/state/preset-file';
import { buildParamCatalog } from '../../src/state/param-catalog';

export const core = {
  validateSongFile, isAuthorSong, expandAuthorSong,
  compactSongForExport, buildAuthoringGuide, buildSongPrompt,
  ParamBus, registerDefaults, buildParamCatalog,
  // presets (preset-authoring.md)
  buildPresetGuide, validatePresetPayload, expandPresetParams,
  buildPresetFile, buildBankFile, presetFilename, bankFilename,
};
