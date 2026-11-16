/**
 * The Song panel's way in and way out for song files (song-mode.md,
 * project-export.md, pwa-install.md REQ-one-import-parse-path):
 *
 * - **import** — one surface for both formats: sniff the bytes, parse as a
 *   project zip or plain JSON, apply, persist only if the user would not lose a
 *   different saved song by it;
 * - **the project-bundle apply** — shared with the zip demos;
 * - **export** — Song (.json) or Project (.zip with the loaded clips), and the
 *   share link;
 * - **the failure dialogs** both directions use.
 *
 * State lives in the SongSession (song-session.ts); this module holds none.
 */
import type { StudioApi } from '../studio-api';
import type { UiBridge } from '../ui-bridge';
import { confirmDialog, alertDialog } from '../components/dialog';
import {
  buildFailureReport, buildFailureReportFor, failureMessage, isCapped, thrownMessage,
} from '../failure-report';
import { describePresetPayload } from '../../state/preset-file';
import { oversizedFileMessage } from '../../state/import-cap';
import { Song, type SongFile } from '../../state/song';
import {
  buildProjectZip, encodeClip, projectFilename, parseSongOrProject,
  type ProjectClipOut, type ProjectClipIn,
} from '../../state/project';
import { encodeSongPayload, buildShareUrl } from '../../state/song-link';
import { triggerDownload } from '../../utils/download';
import { audioBufferView } from '../../audio/recorder/audio-buffer';
import { SAMPLER_SLOT_COUNT } from '../../state/patterns';
import type { SlotPicker, SongSession } from './song-session';

/**
 * Report a list of parse failures: the first few bulleted, **all** of them on
 * the clipboard (song-mode.md REQ-a-rejected-import-is-copyable-in-full, dialog.md
 * REQ-an-alert-may-offer-copyable-text). The validator collects up to MAX_ERRORS
 * and they are written nowhere else, so the Copy button gets the whole array.
 */
export const failureAlert = (
  title: string, lead: string, errors: string[], file?: string,
): Promise<void> => alertDialog({
  title,
  message: failureMessage(lead, errors),
  copyable: buildFailureReport({ title, file, errors, capped: isCapped(errors) }),
});

/**
 * The same dialog for a step that *threw* rather than returned errors: the
 * message after `lead`, and the report a user can copy
 * (failure-report.md REQ-a-thrown-value-is-named-here).
 */
export const thrownAlert = (title: string, lead: string, e: unknown, file?: string): Promise<void> => {
  const message = thrownMessage(e);
  return alertDialog({
    title,
    message: lead + message,
    copyable: buildFailureReportFor(title, message, file),
    copyLabel: 'Copy error',
  });
};

const showImportErrors = (errors: string[], file?: string): Promise<void> =>
  failureAlert('Import failed', 'Could not import song', errors, file);

/**
 * Persist an imported song to its slot — but never *silently* over a
 * **different** existing one (session-autosave.md
 * REQ-the-undo-net-covers-the-session/REQ-an-identical-slot-is-not-a-conflict,
 * untrusted-input.md REQ-an-import-may-not-destroy-saved-work).
 *
 * The name comes from the file, so with a share link it is attacker-chosen: a
 * song called "My Song" would otherwise destroy the user's slot of that name at
 * boot, and the load-undo toast cannot bring it back — it restores the in-memory
 * session, not localStorage. Declining still leaves the song applied; only the
 * persistence is skipped. Re-importing a song the slot already holds asks
 * nothing (`planImportSave` compares contents). Returns whether the slot was written.
 */
async function saveImportedSlot(file: SongFile): Promise<boolean> {
  const plan = Song.planImportSave(file);
  if (plan.conflict) {
    const ok = await confirmDialog({
      title: 'Replace your saved song?',
      message: `You already have a saved song called "${plan.name}". Saving this import would replace it.`,
      detail: 'The imported song is loaded either way — declining just keeps your saved copy.',
      confirmLabel: 'Replace it',
      cancelLabel: 'Keep mine',
      danger: true,
    });
    if (!ok) return false;
  }
  Song.saveSlot(file.name, file);
  return true;
}

export interface SongIoDeps {
  engine: StudioApi;
  bridge: UiBridge;
  song: SongSession;
  picker: SlotPicker;
}

export interface SongIo {
  /**
   * Apply a parsed project bundle (import + zip demos), persist it if it is the
   * user's, then decode the clips into the sampler.
   */
  applyProjectBundle(
    bundle: { file: SongFile; clips: ProjectClipIn[] },
    opts: { persist: boolean; name?: string },
  ): Promise<void>;
  /** Sniff → parse → apply raw song/project bytes. Resolves to whether it applied. */
  importBytes(bytes: Uint8Array, name: string): Promise<boolean>;
  /** A song/project `File`, sized before it is read. Resolves to whether it applied. */
  importFile(file: File): Promise<boolean>;
  /** Export the current song as JSON or a project zip; a failure says so. */
  runExport(kind: 'json' | 'project', fmt: 'wav' | 'mp3'): Promise<void>;
  /** The current song as a `#song=` share URL (song-share-link.md REQ-export-modal-copies-a-link). */
  makeShareUrl(): Promise<string>;
}

export function createSongIo(deps: SongIoDeps): SongIo {
  const { engine, bridge, song, picker } = deps;
  const exportName = (): string => picker.value || 'My Song';

  /**
   * Apply the song, persist it if it is the user's, then decode the clips into
   * the sampler — sequentially (8 × multi-MB WAVs, project-export.md
   * REQ-clip-codec-is-memory-aware). A failed clip never aborts: the slot just
   * keeps the .needs-reload hint; failures collect into ONE alert.
   *
   * `persist` is what separates the two callers (session-autosave.md
   * REQ-a-demo-click-never-writes-a-slot): an import is the user's work arriving
   * and earns a slot; a demo is read-only content and must not write one.
   */
  const applyProjectBundle: SongIo['applyProjectBundle'] = async (
    { file, clips }, { persist, name = file.name },
  ) => {
    song.applyWithUndo(file, persist ? 'Imported' : 'Loaded');
    // Synchronously, before the decodes: an Undo pressed while the clips are
    // still decoding must not be followed by a late re-mark.
    if (!persist) song.setLoadedDemo(name);
    // Undo (or any newer apply) during the sequential decodes below must win:
    // a late clip may not touch the restored session's slots
    // (session-autosave.md REQ-superseded-async-work-must-not-leak).
    const token = song.applyToken;
    // JSON only — after a reload, .needs-reload correctly reappears.
    const saved = persist && await saveImportedSlot(file);
    // A demo syncs the picker the way applyDemo always has; an import only
    // once its slot exists (a declined overwrite leaves the old selection).
    if (saved || !persist) {
      picker.refresh();
      picker.select(name);
    }
    song.slot = saved ? file.name : null;
    bridge.cuePlay(); // imports + zip demos are silent until Play (play-button-blink.md REQ-silent-actions-arm-a-green-cue)
    const failures: string[] = [];
    for (const clip of clips) {
      if (token !== song.applyToken) return;
      try {
        // .slice() is mandatory: clip bytes are subarray views of the whole
        // zip buffer, and decodeAudioData detaches the buffer it is given.
        const buf = await engine.ctx.decodeAudioData(clip.data.slice().buffer);
        engine.sampler.setBuffer(clip.slot, buf);
        // Prefer the song's own sampleNames entry; fall back to the zip entry
        // name. Always re-set it: setSampleName's meta event is what tells the
        // sampler panel to drop the .needs-reload hint now the buffer is live.
        engine.patterns.setSampleName(
          clip.slot,
          engine.patterns.sampleNames[clip.slot]
            ?? clip.entryName.replace(/^.*\//, '').replace(/^\d+-/, ''),
        );
      } catch {
        failures.push(clip.entryName);
      }
    }
    if (failures.length > 0) {
      await alertDialog({
        title: 'Some clips failed',
        message: `The song ${persist ? 'was imported' : 'loaded'}, but these clips `
          + 'could not be decoded:\n• ' + failures.join('\n• '),
        copyable: buildFailureReport({ title: 'Some clips failed', errors: failures }),
        copyLabel: failures.length === 1 ? 'Copy error' : 'Copy errors',
      });
    }
  };

  const importBytes: SongIo['importBytes'] = async (bytes, name) => {
    const res = await parseSongOrProject(bytes, name);
    if (!res.ok) {
      // Preset and bank files share the `.websynth.json` tail with songs, so
      // users land here by mistake. Point at the right door instead of reporting
      // a schema failure they can do nothing with (presets.md REQ-a-malformed-preset-is-refused-with-a-reason).
      const wrongDoor = describePresetPayload(new TextDecoder().decode(bytes));
      if (wrongDoor) {
        await alertDialog({
          title: `That is a ${wrongDoor} file`,
          message: `"${name}" holds sounds, not a song.\n\nOpen it from the header's Preset button → Import.`,
        });
        return false;
      }
      await showImportErrors(res.errors, name);
      return false;
    }
    try {
      await applyProjectBundle(res, { persist: true }); // the user's work — it earns a slot
      return true;
    } catch (e) {
      await thrownAlert('Import failed', 'Song imported but failed to apply: ', e, name);
      return false;
    }
  };

  // Sized before it is read (untrusted-input.md REQ-a-file-is-sized-before-it-is-read):
  // `File.size` is free, and a cap applied after `arrayBuffer()` has already
  // spent the memory.
  const importFile: SongIo['importFile'] = async (file) => {
    const oversized = oversizedFileMessage(file);
    if (oversized) {
      await showImportErrors([oversized], file.name);
      return false;
    }
    return importBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  };

  // Export: Song (.json, the unchanged path) or Project (.zip with the loaded
  // sampler clips) — chosen in a modal (project-export.md REQ-export-modal-offers-song-or-project).
  const doExport = async (kind: 'json' | 'project', fmt: 'wav' | 'mp3'): Promise<void> => {
    const name = exportName();
    const file = song.capture(name);
    if (kind === 'json') {
      Song.download(file);
      return;
    }
    const clips: ProjectClipOut[] = [];
    for (let slot = 0; slot < SAMPLER_SLOT_COUNT; slot++) {
      const buf = engine.sampler.buffers[slot];
      if (!buf) continue;
      // Encode + materialize one clip at a time (8 × multi-MB WAVs — REQ-clip-codec-is-memory-aware).
      // Uncopied: encoding only reads, and a slot's buffer is replaced, never
      // written in place (sampler.md REQ-set-buffer-is-the-one-door).
      const { blob, ext } = await encodeClip(audioBufferView(buf), fmt);
      clips.push({ slot, data: new Uint8Array(await blob.arrayBuffer()), ext });
    }
    const bytes = await buildProjectZip(file, clips);
    triggerDownload(new Blob([bytes as BlobPart], { type: 'application/zip' }), projectFilename(name));
  };

  return {
    applyProjectBundle,
    importBytes,
    importFile,
    // An export that fails says so — the zip codec is a lazy chunk, and a
    // rejection here used to vanish into `void` (project-export.md REQ-the-zip-codec-loads-with-the-first-zip).
    async runExport(kind, fmt) {
      try {
        await doExport(kind, fmt);
      } catch (e) {
        await thrownAlert('Export failed', 'The song could not be exported: ', e, exportName());
      }
    },
    async makeShareUrl() {
      return buildShareUrl(window.location.origin, await encodeSongPayload(Song.toJSON(song.capture(exportName()))));
    },
  };
}
