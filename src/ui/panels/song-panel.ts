import type { ParamBus } from '../../state/params';
import type { PresetSession } from '../../state/preset-session';
import type { XyPadStore } from '../../state/xy-pad';
import type { StudioApi } from '../studio-api';
import type { UiBridge } from '../ui-bridge';
import type { ChainLane } from '../../audio/transport/arrangement';
import type { ExportFormat } from '../../audio/recorder/recorder-controller';
import { Knob } from '../components/knob';
import { Switch } from '../components/switch';
import { Dropdown } from '../components/dropdown';
import { audibleLanes, LANE_IDS, type LaneId } from '../../audio/transport/lane-mix';
import { laneFlags, MACHINE_TAB } from '../machine-status';
import { fxGroup } from '../components/fx-group';
import { GrMeter } from '../components/gr-meter';
import type { XyPadWindowController } from '../components/xy-pad-window';
import { buildLiveFxControls, xyPadLaunchButton, createLiveFxWindowLauncher } from '../components/live-fx';
import { createAiPromptButton } from '../components/ai-prompt';
import { buildSyncSection } from '../components/sync-section';
import {
  buildTransportControls, createTransportWindowLauncher, bindSeekAvailability, transportRowClass,
} from '../components/transport-controls';
import { confirmDialog, promptDialog, alertDialog } from '../components/dialog';
import { describePresetPayload, type PresetParse } from '../../state/preset-file';
import { openPasteImportModal } from '../components/paste-import';
import { showToast } from '../components/toast';
import { BANK_LABELS, REST, SAMPLER_SLOT_COUNT, emptyPatternSnapshot } from '../../state/patterns';
import { restIcon } from '../components/rest-glyph';
import switchStyles from '../styles/switch.module.css';
import bankStyles from '../styles/bank-bar.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import styles from '../styles/song-panel.module.css';
import layout from '../styles/layout.module.css';
import { Song, DEMO_SONGS, JSON_DEMOS, ZIP_DEMOS, demoNames, type SongFile } from '../../state/song';
import {
  buildProjectZip, parseProjectZip, encodeClip, projectFilename, parseSongOrProject,
  type ProjectClipOut, type ProjectClipIn,
} from '../../state/project';
import { openExportSongModal } from '../components/export-song-modal';
import { encodeSongPayload, buildShareUrl } from '../../state/song-link';
import { triggerDownload } from '../../audio/recorder/encode';
import { audioBufferToCaptured } from '../../audio/recorder/audio-buffer';

/** Demo buttons shown inline; the rest hide behind "All Demos" (song-mode.md REQ-10). */
const DEMO_ROW_LIMIT = 6;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface SongPanel {
  el: HTMLElement;
  /**
   * Load a demo by name AND sync the slot dropdown (shared with the demo
   * buttons). Resolves once applied — all but the two built-in demos are
   * fetched on click (song-mode.md REQ-12), so callers that act on the loaded
   * song must await it.
   */
  loadDemo: (name: string) => Promise<void>;
  /**
   * Import raw song/project bytes exactly like the Import button (sniff →
   * parse → apply, errors shown in the same dialogs). Driven by the installed
   * PWA's launchQueue and by share links via `UiBridge.importSongBytes`
   * (pwa-install.md REQ-5/7, song-share-link.md REQ-3). Resolves to whether
   * the song applied (share links clear their hash only on success).
   */
  importBytes: (bytes: Uint8Array, name: string) => Promise<boolean>;
}

export function buildSongPanel(bus: ParamBus, engine: StudioApi, session: PresetSession, xy: XyPadStore, bridge: UiBridge, xyWin: XyPadWindowController): SongPanel {
  const root = el('div', `${layout.patternPanel!} ${styles.panel!}`);

  // Apply a song AND label the selector with its name (all apply sites route
  // through here so the header reflects the loaded song). Each apply bumps the
  // token so async work from a superseded apply (project-zip clip decodes)
  // can detect it lost the session (session-autosave.md REQ-9).
  let applyToken = 0;
  const applySong = (file: SongFile): void => {
    applyToken++;
    // `engine.sampler` lets apply evict audio the incoming song renames, so a
    // slot's label can never outlive the sound under it (song-mode.md REQ-3b).
    Song.apply(file, bus, engine.patterns, engine.arrangement, xy, engine.sampler);
    session.setActive(file.name);
  };

  // ---- Load-undo safety net (session-autosave.md REQ-7/REQ-8) ----
  // Every destructive apply stashes the session it overwrites — the captured
  // SongFile PLUS the live sampler AudioBuffer refs (a SongFile only carries
  // names) — and offers Undo via a toast. The stash lives solely in the
  // toast's closure, so dismissal/replacement releases the buffers.
  interface SessionStash {
    file: SongFile;
    buffers: (AudioBuffer | null)[];
    slot: string;
  }
  // Only ever called from click handlers, so `dropdown` (built below) exists.
  const stashCurrent = (): SessionStash => ({
    file: Song.capture(bus, engine.patterns, engine.arrangement, session.label || 'My Song', xy),
    buffers: [...engine.sampler.buffers],
    slot: dropdown.value,
  });
  const restoreStash = (stash: SessionStash): void => {
    applySong(stash.file);
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
      engine.sampler.setBuffer(i, stash.buffers[i] ?? null);
      // Re-fire the meta event AFTER the buffer lands — that's what clears
      // .needs-reload in the sampler panel (same idiom as the zip import).
      engine.patterns.setSampleName(i, stash.file.sampleNames?.[i] ?? null);
    }
    refreshList();
    dropdown.setValue(stash.slot);
  };
  const showUndoToast = (message: string, stash: SessionStash): void => {
    showToast({
      message,
      actionLabel: 'Undo',
      testId: 'song-undo-toast',
      onAction: () => restoreStash(stash),
    });
  };
  const applySongWithUndo = (file: SongFile, verb = 'Loaded'): void => {
    const stash = stashCurrent();
    applySong(file);
    showUndoToast(`${verb} "${file.name}"`, stash);
  };

  // ---- Chain lanes (each with DJ mute / solo / volume) ----
  const chains = el('div', styles.chains!);
  const laneEls: Record<LaneId, HTMLElement> = {
    seq: buildChainLane(
      'Sequencer', 'seq', bus, engine.arrangement.seq,
      (s, en) => engine.arrangement.setSeqChain(s, en),
      () => engine.arrangement.seqChainPos, engine, bridge),
    drum: buildChainLane(
      'Drums', 'drum', bus, engine.arrangement.drum,
      (s, en) => engine.arrangement.setDrumChain(s, en),
      () => engine.arrangement.drumChainPos, engine, bridge),
    sampler: buildChainLane(
      'Sampler', 'sampler', bus, engine.arrangement.sampler,
      (s, en) => engine.arrangement.setSamplerChain(s, en),
      () => engine.arrangement.samplerChainPos, engine, bridge),
  };
  for (const id of LANE_IDS) chains.appendChild(laneEls[id]);
  // Motion is not an audio lane (no solo/volume, outside audibleLanes) — its
  // card is chain + Mute (motion-sequencer.md REQ-6/REQ-12): muting deactivates
  // the machine and restores every driven param's baseline.
  const motionEl = buildChainLane(
    'Motion', 'motion', bus, engine.arrangement.motion,
    (s, en) => engine.arrangement.setMotionChain(s, en),
    () => engine.arrangement.motionChainPos, engine, bridge, { mixer: 'mute' });
  chains.appendChild(motionEl);
  root.appendChild(chains);

  // Dim a lane card whenever it is silenced — by its own mute or by another
  // lane's solo. Uses the same `audibleLanes` rule the engine applies, so the
  // visual can never disagree with what you hear.
  const refreshSilenced = (): void => {
    const audible = audibleLanes(laneFlags(bus, 'mute'), laneFlags(bus, 'solo'));
    for (const id of LANE_IDS) laneEls[id].classList.toggle(styles.silenced!, !audible[id]);
  };
  for (const id of LANE_IDS) {
    bus.subscribe(`${id}.mute`, refreshSilenced);
    bus.subscribe(`${id}.solo`, refreshSilenced);
  }
  // Motion sits outside audibleLanes (it makes no sound) — its dim visual is
  // driven straight off its own mute param.
  bus.subscribe('motion.mute', (v) => motionEl.classList.toggle(styles.silenced!, v >= 0.5));

  // ---- Transport (transport-window.md) ----
  // Directly under the four machine lanes, above Live FX: the scrubber is a
  // bar-per-slot view of the chains right above it, so it reads as their ruler.
  // Deliberately compact — the launcher doubles as the section title and
  // Play/Stop lives only in the floating window; the point of undocking is to
  // give this panel's height back, not to duplicate it. BPM and SWING are on
  // neither surface: they are permanently in the header, and only that copy
  // knows to disable itself while slaved (transport-window.md REQ-2).
  const transport = el('div', transportRowClass);
  transport.appendChild(createTransportWindowLauncher(engine, bridge));
  for (const c of buildTransportControls(engine, bridge, { compact: true })) {
    transport.appendChild(c);
  }
  bindSeekAvailability(engine, transport);
  root.appendChild(transport);

  // ---- Live DJ FX ----
  // The shared XY Pad window controller comes from app.ts: the Song panel's
  // launcher, the LIVE FX window's, and the Motion panel's all toggle the SAME
  // window (never two).
  const fx = el('div', styles.djFx!);
  // The LIVE FX launcher doubles as the section title (replaces the old text label,
  // saving space) and leads the row; it opens the floating window usable off the Song tab.
  fx.appendChild(createLiveFxWindowLauncher(engine, bus, xyWin));
  fx.appendChild(new Knob({ bus, paramId: 'fx.djfilter', label: 'DJ FLT' }).el);
  for (const c of buildLiveFxControls(engine)) fx.appendChild(c); // Fill / Stutter / Drop / Tape Stop (perf-*)
  fx.appendChild(xyPadLaunchButton(xyWin, 'perf-xypad'));
  const masterGr = new GrMeter('grmeter-fx.master.comp');
  engine.masterComp.onGr((db) => masterGr.update(db));
  fx.appendChild(fxGroup(bus, 'COMP', 'fx.master.comp', [
    { id: 'fx.master.comp.threshold', label: 'THR' },
    { id: 'fx.master.comp.ratio', label: 'RATIO' },
    { id: 'fx.master.comp.attack', label: 'ATK' },
    { id: 'fx.master.comp.release', label: 'REL' },
    { id: 'fx.master.comp.makeup', label: 'GAIN' },
  ], { trailing: masterGr.el }));
  root.appendChild(fx);

  // ---- Song I/O ----
  const io = el('div', styles.io!);
  io.appendChild(el('div', styles.sectionLabel!, 'Song'));

  const dropdown = new Dropdown(Song.list(), Song.list()[0] ?? '');
  dropdown.el.dataset.testid = 'song-slot-select';
  const refreshList = () => dropdown.setOptions(Song.list());

  const showImportErrors = (errors: string[]): Promise<void> => {
    const shown = errors.slice(0, 8);
    const more = errors.length - shown.length;
    return alertDialog({
      title: 'Import failed',
      message: 'Could not import song:\n• ' + shown.join('\n• ') + (more > 0 ? `\n…and ${more} more` : ''),
    });
  };

  // Shared project-bundle apply (import + demo zips): apply/save the song like
  // a JSON import, then decode the clips into the sampler — sequentially (8 ×
  // multi-MB WAVs, project-export.md REQ-8). A failed clip never aborts: the
  // slot just keeps the .needs-reload hint; failures collect into ONE alert.
  const applyProjectBundle = async ({ file, clips }: { file: SongFile; clips: ProjectClipIn[] }): Promise<void> => {
    applySongWithUndo(file, 'Imported');
    // Undo (or any newer apply) during the sequential decodes below must win:
    // a late clip may not touch the restored session's slots (REQ-9).
    const token = applyToken;
    Song.saveSlot(file.name, file); // JSON only — after a reload, .needs-reload correctly reappears
    refreshList();
    dropdown.setValue(file.name);
    bridge.cuePlay(); // imports + zip demos are silent until Play (play-button-blink.md REQ-3)
    const failures: string[] = [];
    for (const clip of clips) {
      if (token !== applyToken) return;
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
        message: 'The song was imported, but these clips could not be decoded:\n• ' + failures.join('\n• '),
      });
    }
  };

  const loadZipDemo = async (name: string, url: string): Promise<void> => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
      const res = await parseProjectZip(new Uint8Array(await resp.arrayBuffer()));
      if (!res.ok) throw new Error(res.errors[0] ?? 'invalid project zip');
      await applyProjectBundle(res);
    } catch (e) {
      await alertDialog({
        title: 'Demo failed to load',
        message: `Could not load "${name}": ` + (e as Error).message,
      });
    }
  };

  /** Apply a parsed demo + sync the slot dropdown. The tail every branch ends on. */
  const applyDemo = (name: string, file: SongFile): void => {
    applySongWithUndo(file);
    refreshList();
    dropdown.setValue(name);
    bridge.cuePlay(); // nudge Play (play-button-blink.md REQ-3)
  };

  const loadJsonDemo = async (name: string, url: string): Promise<void> => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
      // Same validator the Import button uses, so a corrupt drop-in reports
      // what is actually wrong with it rather than "not a song".
      const res = Song.parse(await resp.text());
      if (!res.ok) throw new Error(res.errors[0] ?? 'not a valid song file');
      applyDemo(name, res.file);
    } catch (e) {
      await alertDialog({
        title: 'Demo failed to load',
        message: `Could not load "${name}": ` + (e as Error).message,
      });
    }
  };

  // Shared demo-load: apply the song AND sync the slot dropdown. Used by the
  // demo buttons, the Load button, the guided tour and the empty-play hint.
  //
  // **Resolves when the song has actually been applied.** Only the two built-ins
  // are immediate; the drop-in JSON and the project zips are fetched on click
  // (song-mode.md REQ-12), so any caller that acts on the loaded song — the tour
  // starting the transport, the empty-play modal pressing Play — must await this
  // or it will run against the song that was there before.
  const loadDemo = async (name: string): Promise<void> => {
    const file = DEMO_SONGS[name];
    if (file) {
      applyDemo(name, file);
      return;
    }
    const jsonDemo = JSON_DEMOS.find((d) => d.name === name);
    if (jsonDemo) return loadJsonDemo(jsonDemo.name, jsonDemo.url);
    const zipDemo = ZIP_DEMOS.find((d) => d.name === name);
    if (zipDemo) return loadZipDemo(zipDemo.name, zipDemo.url);
  };

  const loadBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Load') as HTMLButtonElement;
  loadBtn.dataset.testid = 'song-load';
  loadBtn.addEventListener('click', () => {
    const f = Song.loadSlot(dropdown.value);
    if (f) {
      applySongWithUndo(f);
      bridge.cuePlay(); // a loaded song is silent until Play (play-button-blink.md REQ-3)
      return;
    }
    // The list also carries the drop-in demos, which `loadSlot` cannot return
    // because they are fetched rather than bundled (song-mode.md REQ-12).
    // `loadDemo` knows all three demo sources and cues Play itself.
    void loadDemo(dropdown.value);
  });

  const saveBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Save') as HTMLButtonElement;
  saveBtn.dataset.testid = 'song-save';
  saveBtn.addEventListener('click', async () => {
    const name = await promptDialog({
      title: 'Save song',
      message: 'Song name:',
      defaultValue: dropdown.value || 'My Song',
      confirmLabel: 'Save',
    });
    if (!name) return;
    const file = Song.capture(bus, engine.patterns, engine.arrangement, name, xy);
    Song.saveSlot(name, file);
    // The saved song's params become the new double-tap reset target.
    bus.setBaselines(file.params);
    Song.download(file);
    refreshList();
    dropdown.setValue(name);
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,.zip,application/json,application/zip';
  fileInput.style.display = 'none';
  fileInput.dataset.testid = 'song-import-file';
  // One import surface for both formats (pwa-install.md REQ-7): sniff the
  // magic bytes (PK first, extension fallback) and route to the project-zip
  // or plain-JSON parser — shared verbatim by the file input and the
  // installed-PWA file-launch path (SongPanel.importBytes).
  const importBytes = async (bytes: Uint8Array, name: string): Promise<boolean> => {
    const res = await parseSongOrProject(bytes, name);
    if (!res.ok) {
      // Preset and bank files share the `.websynth.json` tail with songs, so
      // users land here by mistake. Point at the right door instead of reporting
      // a schema failure they can do nothing with (presets.md REQ-11).
      const wrongDoor = describePresetPayload(new TextDecoder().decode(bytes));
      if (wrongDoor) {
        await alertDialog({
          title: `That is a ${wrongDoor} file`,
          message: `"${name}" holds sounds, not a song.\n\nOpen it from the header's Preset button → Import.`,
        });
        return false;
      }
      await showImportErrors(res.errors);
      return false;
    }
    try {
      await applyProjectBundle(res);
      return true;
    } catch (e) {
      await alertDialog({
        title: 'Import failed',
        message: 'Song imported but failed to apply: ' + (e as Error).message,
      });
      return false;
    }
  };
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    fileInput.value = '';
    await importBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  });
  const importBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Import') as HTMLButtonElement;
  importBtn.dataset.testid = 'song-import';
  importBtn.addEventListener('click', () => fileInput.click());

  // The same two routes the ✨ AI Prompt modal's step 3 uses — songs through the
  // file path above, presets through the manager's review step (paste-import.md).
  const pasteRoutes = {
    onSong: importBytes,
    onPresets: (parse: PresetParse) => bridge.openPresetImport(parse),
  };
  const pasteBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Paste') as HTMLButtonElement;
  pasteBtn.dataset.testid = 'song-paste';
  pasteBtn.title = 'Paste song or preset JSON (e.g. an AI reply)';
  pasteBtn.addEventListener('click', () => openPasteImportModal(pasteRoutes));

  // Export: Song (.json, the unchanged path) or Project (.zip with the loaded
  // sampler clips) — chosen in a modal (project-export.md REQ-4).
  const doExport = async (kind: 'json' | 'project', fmt: 'wav' | 'mp3'): Promise<void> => {
    const name = dropdown.value || 'My Song';
    const file = Song.capture(bus, engine.patterns, engine.arrangement, name, xy);
    if (kind === 'json') {
      Song.download(file);
      return;
    }
    const clips: ProjectClipOut[] = [];
    for (let slot = 0; slot < SAMPLER_SLOT_COUNT; slot++) {
      const buf = engine.sampler.buffers[slot];
      if (!buf) continue;
      // Encode + materialize one clip at a time (8 × multi-MB WAVs — REQ-8).
      const { blob, ext } = await encodeClip(audioBufferToCaptured(buf), fmt);
      clips.push({ slot, data: new Uint8Array(await blob.arrayBuffer()), ext });
    }
    const bytes = await buildProjectZip(file, clips);
    triggerDownload(new Blob([bytes as BlobPart], { type: 'application/zip' }), projectFilename(name));
  };

  const exportBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Export') as HTMLButtonElement;
  exportBtn.dataset.testid = 'song-export';
  exportBtn.addEventListener('click', () => {
    openExportSongModal({
      hasSamplerAudio: engine.sampler.buffers.some((b) => b != null),
      onExport: (kind, fmt) => { void doExport(kind, fmt); },
      // Copy Link: the current song as a #song= URL (song-share-link.md REQ-5).
      makeShareUrl: async () => {
        const name = dropdown.value || 'My Song';
        const file = Song.capture(bus, engine.patterns, engine.arrangement, name, xy);
        return buildShareUrl(window.location.origin, await encodeSongPayload(Song.toJSON(file)));
      },
    });
  });

  const newBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'New') as HTMLButtonElement;
  newBtn.dataset.testid = 'song-new';
  newBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'New song',
      message: 'Clear all banks and chains? This starts a blank song.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    // Confirmed — but still stash + toast (session-autosave.md REQ-7): New is
    // the one path that also nulls the sampler buffers, so Undo is the only
    // way back to a stash with its audio intact.
    const stash = stashCurrent();
    applyToken++; // a confirmed New also supersedes any in-flight clip decodes
    // Same authoritative blank the load path uses (song-mode.md REQ-3).
    engine.patterns.restore(emptyPatternSnapshot());
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) engine.sampler.setBuffer(i, null);
    engine.arrangement.setSeqChain([0], false);
    engine.arrangement.setDrumChain([0], false);
    engine.arrangement.setSamplerChain([0], false);
    engine.arrangement.setMotionChain([0], false);
    showUndoToast('Started a new song', stash);
  });

  io.appendChild(el('span', styles.ioLabel!, 'Slot:'));
  io.appendChild(dropdown.el);
  io.appendChild(loadBtn);
  io.appendChild(saveBtn);
  io.appendChild(importBtn);
  io.appendChild(pasteBtn);
  io.appendChild(exportBtn);
  io.appendChild(newBtn);
  io.appendChild(fileInput);

  io.appendChild(el('span', styles.ioLabel!, 'Demos:'));
  const mkDemoBtn = (name: string, onClick: () => void): HTMLButtonElement => {
    const d = el('button', `${switchStyles.root!} ${styles.demo!}`, name) as HTMLButtonElement;
    d.dataset.testid = `song-demo-${name}`;
    d.addEventListener('click', onClick);
    return d;
  };
  // Drop-in JSON, then the built-ins, then the project-zip demos. `demoNames()`
  // owns that order; everything routes through `loadDemo`, which knows which of
  // the three a name belongs to (the fetched ones need a user gesture anyway, so
  // decodeAudioData is unlocked — project-export.md REQ-7).
  const demoButtons = demoNames().map((name) => mkDemoBtn(name, () => { void loadDemo(name); }));
  // Only the first DEMO_ROW_LIMIT stay inline; the rest tuck behind an
  // "All Demos" toggle so the row doesn't crowd the panel (song-mode.md REQ-10).
  for (const d of demoButtons.slice(0, DEMO_ROW_LIMIT)) io.appendChild(d);
  const overflowDemos = demoButtons.slice(DEMO_ROW_LIMIT);
  if (overflowDemos.length > 0) {
    const moreBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'All Demos') as HTMLButtonElement;
    moreBtn.dataset.testid = 'song-demo-more';
    // display: contents while open, so the revealed buttons flow in the same row.
    const overflow = el('span', styles.demoOverflow!);
    for (const d of overflowDemos) overflow.appendChild(d);
    moreBtn.addEventListener('click', () => {
      const open = overflow.classList.toggle(styles.demoOpen!);
      moreBtn.classList.toggle('on', open);
      moreBtn.textContent = open ? 'Less' : 'All Demos';
    });
    io.appendChild(moreBtn);
    io.appendChild(overflow);
  }
  io.appendChild(createAiPromptButton(bus, pasteRoutes));
  root.appendChild(io);

  // ---- Audio export (WAV / MP3) ----
  const aio = el('div', styles.io!);
  aio.appendChild(el('div', styles.sectionLabel!, 'Audio'));

  let fmt: ExportFormat = 'wav';

  const expSongBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`) as HTMLButtonElement;
  expSongBtn.dataset.testid = 'song-export-audio';
  expSongBtn.title = 'Render one full pass of the arrangement, then download';
  expSongBtn.addEventListener('click', () => engine.recorder.exportSong(fmt));

  const recBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`) as HTMLButtonElement;
  recBtn.dataset.testid = 'song-record';
  recBtn.title = 'Free-form record toggle (starts the transport if stopped)';
  recBtn.addEventListener('click', () => engine.recorder.toggleManual(fmt));

  // Both labels name the format they will write (audio-export.md REQ-8), so the
  // Format switch is never the only clue. One writer for both, since the record
  // button's text is also driven by the recorder's state.
  let recording = false;
  const syncAudioLabels = (): void => {
    const f = fmt.toUpperCase();
    expSongBtn.textContent = `Export Song as ${f}`;
    recBtn.textContent = recording ? 'Stop' : `Record as ${f}`;
  };
  engine.recorder.onState((rec) => {
    recording = rec;
    recBtn.classList.toggle('on', rec);
    syncAudioLabels();
  });

  const fmtSel = el('div', segmentedStyles.root!);
  ([['WAV', 'wav'], ['MP3', 'mp3']] as Array<[string, ExportFormat]>).forEach(([lbl, f], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = lbl;
    b.dataset.testid = `song-export-fmt-${f}`;
    if (i === 0) b.classList.add('active');
    b.addEventListener('click', () => {
      fmt = f;
      for (const c of Array.from(fmtSel.children)) c.classList.remove('active');
      b.classList.add('active');
      syncAudioLabels();
    });
    fmtSel.appendChild(b);
  });
  syncAudioLabels();

  aio.appendChild(el('span', styles.ioLabel!, 'Format:'));
  aio.appendChild(fmtSel);
  aio.appendChild(expSongBtn);
  aio.appendChild(recBtn);
  root.appendChild(aio);

  // ---- Transport sync (MIDI master/slave + WiFi) ----
  root.appendChild(buildSyncSection(engine.sync, engine.rtcSync));

  return { el: root, loadDemo, importBytes };
}

function buildChainLane(
  title: string,
  prefix: LaneId | 'motion',
  bus: ParamBus,
  lane: ChainLane,
  setChain: (steps: number[], enabled: boolean) => void,
  getPos: () => number,
  engine: StudioApi,
  bridge: UiBridge,
  opts: { mixer?: 'full' | 'mute' | 'none' } = {},
): HTMLElement {
  const root = el('div', styles.lane!);
  root.dataset.testid = `song-lane-${prefix}`;

  const head = el('div', styles.head!);

  // The title navigates to that machine's tab (machine-status.md REQ-5/REQ-6).
  // The ↗ glyph is aria-hidden — the aria-label already names the destination,
  // so it must not be announced as "north east arrow".
  const titleBtn = document.createElement('button');
  titleBtn.type = 'button';
  titleBtn.className = styles.title!;
  titleBtn.dataset.testid = `song-lane-title-${prefix}`;
  titleBtn.setAttribute('aria-label', `Open the ${title} tab`);
  titleBtn.title = `Open the ${title} tab`;
  const arrow = el('span', styles.arrow!, '↗');
  arrow.setAttribute('aria-hidden', 'true');
  titleBtn.append(el('span', '', title), arrow);
  titleBtn.addEventListener('click', () => { bridge.showTab(MACHINE_TAB[prefix]); });
  head.appendChild(titleBtn);

  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.className = `${switchStyles.root!} ${styles.ctl!}`;
  enableBtn.innerHTML = `<span class="${switchStyles.led!}"></span><span class="${switchStyles.label!}">Chain</span>`;
  enableBtn.addEventListener('click', () => {
    if (!lane.enabled) bridge.cuePlay(); // enabling is silent until Play (play-button-blink.md REQ-3)
    setChain([...lane.steps], !lane.enabled);
  });
  head.appendChild(enableBtn);
  root.appendChild(head);

  // DJ mixer strip: mute / solo / volume, so the lane is operable from the Song
  // tab without switching machines. All controls bind straight to ParamBus, so
  // they stay in sync with the per-machine panels and persist with the song.
  // The non-audio motion lane gets 'mute' — a Mute switch only (nothing to mix).
  const mixer = opts.mixer ?? 'full';
  if (mixer !== 'none') {
    const mix = el('div', styles.mix!);
    mix.appendChild(new Switch(bus, `${prefix}.mute`, 'Mute').el);
    if (mixer === 'full') {
      mix.appendChild(new Switch(bus, `${prefix}.solo`, 'Solo').el);
      const vol = new Knob({ bus, paramId: `${prefix}.master`, label: 'Vol', size: 34 });
      vol.el.classList.add(styles.vol!);
      mix.appendChild(vol.el);
    }
    root.appendChild(mix);
  }

  const chips = el('div', styles.chips!);
  root.appendChild(chips);

  let sel = -1;

  const controls = el('div', styles.controls!);
  const addRow = el('div', styles.addRow!);
  BANK_LABELS.forEach((label, i) => {
    const a = el('button', `${bankStyles.btn!} ${styles.add!}`, '') as HTMLButtonElement;
    a.dataset.testid = `chain-add-${prefix}-${i}`;
    a.title = `Add bank ${label}`;
    a.innerHTML = `<span class="${bankStyles.letter!}">${label}</span>`;
    a.addEventListener('click', () => { setChain([...lane.steps, i], lane.enabled); });
    addRow.appendChild(a);
  });
  // Rest: an always-empty bar. Appends the REST sentinel instead of a bank index,
  // so a lane can sit out a bar without spending one of the four banks.
  const rest = el('button', `${bankStyles.btn!} ${styles.add!} ${styles.addRest!}`, '') as HTMLButtonElement;
  rest.dataset.testid = `chain-add-rest-${prefix}`;
  rest.title = 'Add a rest (an empty bar)';
  rest.innerHTML = restIcon();
  rest.addEventListener('click', () => { setChain([...lane.steps, REST], lane.enabled); });
  addRow.appendChild(rest);
  controls.appendChild(addRow);

  const mk = (label: string, fn: () => void) => {
    const b = el('button', `${switchStyles.root!} ${styles.ctl!}`, label) as HTMLButtonElement;
    b.addEventListener('click', fn);
    return b;
  };
  controls.appendChild(mk('◀', () => {
    if (sel > 0) { const s = [...lane.steps]; [s[sel - 1], s[sel]] = [s[sel]!, s[sel - 1]!]; sel--; setChain(s, lane.enabled); }
  }));
  controls.appendChild(mk('▶', () => {
    if (sel >= 0 && sel < lane.steps.length - 1) { const s = [...lane.steps]; [s[sel + 1], s[sel]] = [s[sel]!, s[sel + 1]!]; sel++; setChain(s, lane.enabled); }
  }));
  controls.appendChild(mk('✕', () => {
    if (sel >= 0) { const s = [...lane.steps]; s.splice(sel, 1); sel = -1; setChain(s, lane.enabled); }
  }));
  const clearBtn = mk('Clear', async () => {
    // Nothing to lose if the chain is already a single step — reset silently.
    if (lane.steps.length > 1) {
      const ok = await confirmDialog({
        title: 'Clear chain',
        message: `Clear the ${title} arrangement chain? It resets to a single bank.`,
        confirmLabel: 'Clear',
        danger: true,
      });
      if (!ok) return;
    }
    sel = -1;
    setChain([0], lane.enabled);
  });
  clearBtn.dataset.testid = `chain-clear-${prefix}`;
  controls.appendChild(clearBtn);
  root.appendChild(controls);

  // Split rendering: the chip DOM is rebuilt only when the step list actually
  // changes; the playhead/selection classes update in place every tick. This
  // avoids tearing down and re-creating buttons (and re-attaching listeners)
  // on every bar advance during playback.
  let chipEls: HTMLButtonElement[] = [];
  let lastKey = '';

  const renderPlayState = () => {
    enableBtn.classList.toggle('on', lane.enabled);
    if (sel >= lane.steps.length) sel = -1;
    const pos = getPos();
    chipEls.forEach((c, idx) => {
      c.classList.toggle('sel', idx === sel);
      c.classList.toggle('playing', lane.enabled && idx === pos);
    });
  };

  const renderStructure = () => {
    chips.innerHTML = '';
    chipEls = lane.steps.map((b, idx) => {
      const isRest = b === REST;
      const c = el('button', isRest ? `${styles.chip!} ${styles.rest!}` : styles.chip!) as HTMLButtonElement;
      c.dataset.testid = `chain-chip-${prefix}-${idx}`;
      if (isRest) {
        c.dataset.rest = 'true';
        c.title = 'Rest (empty bar)';
        c.innerHTML = restIcon();
      } else {
        c.textContent = BANK_LABELS[b] ?? '?';
      }
      c.addEventListener('click', () => { sel = idx === sel ? -1 : idx; renderPlayState(); });
      chips.appendChild(c);
      return c;
    });
  };

  const render = () => {
    const key = lane.steps.join(',');
    if (key !== lastKey) { lastKey = key; renderStructure(); }
    renderPlayState();
  };

  engine.arrangement.onChange(render);
  render();
  return root;
}
