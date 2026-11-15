import type { ParamBus } from '../../state/params';
import type { PresetSession } from '../../state/preset-session';
import type { XyPadStore } from '../../state/xy-pad';
import type { StudioApi } from '../studio-api';
import type { UiBridge } from '../ui-bridge';
import type { ExportFormat } from '../../audio/recorder/recorder-controller';
import { Knob } from '../components/knob';
import { Dropdown } from '../components/dropdown';
import { audibleLanes, LANE_IDS, type LaneId } from '../../audio/transport/lane-mix';
import { laneFlags } from '../machine-status';
import { fxGroup, rowDivider } from '../components/fx-group';
import { GrMeter } from '../components/gr-meter';
import type { XyPadWindowController } from '../components/xy-pad-window';
import { buildLiveFxControls, xyPadLaunchButton, modMatrixLaunchButton, createLiveFxWindowLauncher } from '../components/live-fx';
import type { ModMatrixWindowController } from '../components/mod-matrix-window';
import { createAiPromptButton } from '../components/ai-prompt';
import { buildSyncSection } from '../components/sync-section';
import {
  buildTransportControls, createTransportWindowLauncher, bindSeekAvailability, transportRowClass,
} from '../components/transport-controls';
import { confirmDialog, promptName } from '../components/dialog';
import type { PresetParse } from '../../state/preset-file';
// The Paste dialog loads on its click (runtime-performance.md REQ-boot-cost-matches-the-request).
import { showToast } from '../components/toast';
import { installFileDrop } from '../file-drop';
import { loadSurface } from '../components/lazy-load-toast';
import switchStyles from '../styles/switch.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import styles from '../styles/song-panel.module.css';
import { UI_ICONS } from '../components/ui-icons';
import { buildChainLane } from '../components/chain-lane';
import { createButton } from '../components/button';
import panelStyles from '../styles/panel.module.css';
import { Song, demoNames, demoMetaFor, demoFileFor, isDemoName } from '../../state/song';
import { demoSummary } from '../../state/demo-meta';
import { whenIdle } from '../../utils/idle';
// The Export dialog loads on its click (project-export.md REQ-the-zip-codec-loads-with-the-first-zip).
/**
 * The export dialog loads on the click that opens it — a player who never
 * exports never pays for it (runtime-performance.md REQ-boot-cost-matches-the-request). A missing chunk is
 * reported with a retry rather than swallowed (lazy-load-failure.md).
 */
async function openExportAudioModal(engine: StudioApi, fmt: ExportFormat): Promise<void> {
  const m = await loadSurface(
    'the audio export dialog',
    () => import('../components/export-audio-modal'),
    () => void openExportAudioModal(engine, fmt),
  );
  m?.openExportAudioModal(engine, fmt);
}
import { createRecordWindowLauncher } from '../components/record-window';
import { createSongSession, type SlotPicker } from './song-session';
import { createSongIo } from './song-io';
import { createDemoLoader } from './demo-loader';

/** Demo buttons shown inline; the rest hide behind "All Demos" (song-mode.md REQ-the-demo-row-overflows-into-a-menu).
 *  Was 6, which hid most of a growing library; 10 is what fits a desktop row. */
const DEMO_ROW_LIMIT = 10;

/**
 * Say what a demo IS without a click (demo-library.md REQ-demo-row-says-what-it-knows):
 * its facts, and its blurb once that has loaded (REQ-the-blurbs-load-after-boot).
 * The row was nineteen unlabelled buttons; the visible label stays the name
 * because the row is already tight on mobile, so the answer is a richer tooltip,
 * not nineteen wider buttons.
 */
function describeDemo(btn: HTMLElement, name: string, blurb?: string): void {
  const meta = demoMetaFor(name);
  const summary = meta ? demoSummary(meta, blurb) : '';
  if (!summary) return;
  btn.title = `${name} — ${summary}`;
  // The title alone is invisible to a screen reader on a button that already
  // has a text label, so the same sentence goes on aria-label.
  btn.setAttribute('aria-label', `${name}. ${summary}`);
}

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
   * buttons). Resolves once applied — all but the built-in demo are
   * fetched on click (song-mode.md REQ-drop-in-demos-are-fetched-on-click), so callers that act on the loaded
   * song must await it.
   */
  loadDemo: (name: string) => Promise<void>;
  /**
   * Import raw song/project bytes exactly like the Import button (sniff →
   * parse → apply, errors shown in the same dialogs). Driven by `importFile`
   * (the Import button and the installed PWA's launchQueue) and by share links
   * via `UiBridge.importSongBytes`
   * (pwa-install.md REQ-manifest-declares-install-extras and
   * pwa-install.md REQ-one-import-parse-path, song-share-link.md REQ-boot-consumes-a-present-hash).
   * Resolves to whether
   * the song applied (share links clear their hash only on success).
   */
  importBytes: (bytes: Uint8Array, name: string) => Promise<boolean>;
  /**
   * Import a song/project `File` — the Import button's door and the installed
   * PWA's launchQueue (via `UiBridge.importSongFile`). Sized before it is read
   * (untrusted-input.md REQ-a-file-is-sized-before-it-is-read): an oversized file
   * is refused without a byte buffered. Resolves to whether the song applied.
   */
  importFile: (file: File) => Promise<boolean>;
  /**
   * The demo the session was last loaded from, or null — what the demo library
   * marks as loaded from either of its doors (demo-library.md
   * REQ-the-loaded-demo-carries-an-info-button, REQ-info-mode-badges-the-demo-row-once).
   */
  loadedDemo: () => string | null;
}

export function buildSongPanel(bus: ParamBus, engine: StudioApi, session: PresetSession, xy: XyPadStore, bridge: UiBridge, xyWin: XyPadWindowController, modWin: ModMatrixWindowController): SongPanel {
  const root = el('div', `${panelStyles.patternPanel!} ${styles.panel!}`);

  // ---- Chain lanes (each with DJ mute / solo / volume) ----
  const chains = el('div', styles.chains!);
  const laneEls: Record<LaneId, HTMLElement> = {
    seq: buildChainLane(
      'Sequencer', 'seq', bus, engine.arrangement.seq,
      (s, en, tr, o) => engine.arrangement.setSeqChain(s, en, tr, o),
      () => engine.arrangement.seqChainPos, engine, bridge),
    drum: buildChainLane(
      'Drums', 'drum', bus, engine.arrangement.drum,
      (s, en, _tr, o) => engine.arrangement.setDrumChain(s, en, o),
      () => engine.arrangement.drumChainPos, engine, bridge),
    sampler: buildChainLane(
      'Sampler', 'sampler', bus, engine.arrangement.sampler,
      (s, en, _tr, o) => engine.arrangement.setSamplerChain(s, en, o),
      () => engine.arrangement.samplerChainPos, engine, bridge),
  };
  for (const id of LANE_IDS) chains.appendChild(laneEls[id]);
  // Motion is not an audio lane (no solo/volume, outside audibleLanes) — its
  // card is chain + Mute (motion-sequencer.md REQ-motion-has-the-fourth-chain-lane/REQ-motion-mute-is-an-ordinary-param): muting deactivates
  // the machine and restores every driven param's baseline.
  const motionEl = buildChainLane(
    'Motion', 'motion', bus, engine.arrangement.motion,
    (s, en, _tr, o) => engine.arrangement.setMotionChain(s, en, o),
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
  // The launcher doubles as the section title; the row carries the same set as
  // the floating window — Play/Pause and Loop included (transport-window.md
  // REQ-one-transport-control-builder, v5). BPM and SWING are on neither surface: they are permanently in
  // the header, and only that copy knows to disable itself while slaved (midi-clock-sync.md REQ-the-bpm-knob-shows-slaved).
  const transport = el('div', transportRowClass);
  transport.appendChild(createTransportWindowLauncher(engine, bridge));
  for (const c of buildTransportControls(engine, bridge)) {
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
  // MOD is *not* a Live FX control — the rest of this row is momentary performance
  // gestures, and this is a door onto the patch's modulation routing. Same vertical
  // rule `fxGroup` puts before COMP on the other side, so the row reads as three
  // things rather than one long strip.
  fx.appendChild(rowDivider());
  fx.appendChild(modMatrixLaunchButton(modWin, 'perf-mod'));
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
  const ioRow = el('div', styles.io!);
  ioRow.appendChild(el('div', styles.sectionLabel!, 'Song'));

  const dropdown = new Dropdown(Song.list(), Song.list()[0] ?? '');
  dropdown.el.dataset.testid = 'song-slot-select';

  // Delete acts on the picked slot, and only a stored one (song-mode.md
  // REQ-a-saved-song-can-be-deleted) — so its state follows every way the pick changes.
  const deleteBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Delete') as HTMLButtonElement;
  deleteBtn.dataset.testid = 'song-delete';
  const syncDelete = (): void => {
    const stored = Song.hasSlot(dropdown.value);
    deleteBtn.disabled = !stored;
    deleteBtn.title = stored
      ? `Delete the saved song "${dropdown.value}" from this browser`
      : 'Only a song you saved can be deleted — demos stay';
  };
  const refreshList = (): void => { dropdown.setOptions(Song.list()); syncDelete(); };
  /** Show `name` in the picker — the one write path, so Delete keeps up. */
  const selectSlot = (name: string): void => { dropdown.setValue(name); syncDelete(); };
  dropdown.onChange(() => syncDelete());

  const picker: SlotPicker = {
    get value() { return dropdown.value; },
    refresh: refreshList,
    select: selectSlot,
  };
  // The loaded song's state, its import/export paths and the demo door
  // (song-session.ts, song-io.ts, demo-loader.ts) — the panel only wires buttons.
  const song = createSongSession({ bus, engine, session, xy, picker });
  const io = createSongIo({ engine, bridge, song, picker });
  const demos = createDemoLoader({ bridge, song, picker, io });

  const loadBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Load') as HTMLButtonElement;
  loadBtn.dataset.testid = 'song-load';
  loadBtn.addEventListener('click', () => {
    const f = Song.loadSlot(dropdown.value);
    if (f) {
      // No REQ-one-name-two-songs-ask question here: loadSlot already resolved the name in the
      // user's favour, so this branch never reaches loadDemo for a stored slot.
      // (A built-in demo name with no slot also lands here — `song.slot` then
      // marks a demo, not a slot, so `hasSlot` decides.)
      if (Song.hasSlot(dropdown.value)) demos.loadStoredSlot(dropdown.value, f);
      else demos.applyDemo(dropdown.value, f);
      return;
    }
    // The list also carries the drop-in demos, which `loadSlot` cannot return
    // because they are fetched rather than bundled (song-mode.md REQ-drop-in-demos-are-fetched-on-click).
    // `loadDemo` knows all three demo sources and cues Play itself — but this
    // one caller opts OUT of its unknown-name fallback: every picker entry is a
    // slot or a drop-in, so we only land here when a slot vanished mid-click
    // (deleted in another tab), and loading an unrelated song is a worse answer
    // to that race than loading nothing.
    if (isDemoName(dropdown.value)) void demos.loadDemo(dropdown.value);
  });

  const saveBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Save') as HTMLButtonElement;
  saveBtn.dataset.testid = 'song-save';
  saveBtn.addEventListener('click', async () => {
    const name = await promptName({
      title: 'Save song',
      message: 'Song name:',
      defaultValue: dropdown.value || 'My Song',
      confirmLabel: 'Save',
    });
    if (!name) return;
    const file = song.capture(name);
    // Save is a slot write like any other, so it is guarded like any other
    // (session-autosave.md REQ-every-slot-write-is-guarded) — it was the one path that could destroy a
    // saved song with no dialog and no undo. Silent when this IS the slot the
    // session came from: re-saving your own song after an edit is the normal
    // loop and must stay one click.
    if (Song.planSlotSave(file, song.slot).conflict) {
      const ok = await confirmDialog({
        title: `Replace "${name}"?`,
        message: `A different song is already saved under this name. Saving replaces it.`,
        detail: 'That cannot be undone — the Undo toast restores your session, not a saved slot.',
        confirmLabel: 'Replace',
        cancelLabel: 'Back',
        danger: true,
      });
      if (!ok) return;
    }
    Song.saveSlot(name, file);
    song.slot = name;
    // The saved song's params become the new double-tap reset target.
    bus.setBaselines(file.params);
    Song.download(file);
    refreshList();
    selectSlot(name);
  });

  deleteBtn.addEventListener('click', async () => {
    const name = dropdown.value;
    if (!Song.hasSlot(name)) return;
    const ok = await confirmDialog({
      title: `Delete "${name}"?`,
      message: 'The saved song is removed from this browser. What is loaded now is not touched.',
      detail: 'That cannot be undone — export the song first if you may want it back.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    Song.deleteSlot(name);
    // The session no longer comes from a slot, so the next Save of this name is
    // a new slot, not a silent overwrite (session-autosave.md REQ-every-slot-write-is-guarded).
    if (song.slot === name) song.slot = null;
    refreshList();
    selectSlot(Song.list()[0] ?? '');
    showToast({ message: `Deleted "${name}"`, testId: 'song-delete-toast' });
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,.zip,application/json,application/zip';
  fileInput.style.display = 'none';
  fileInput.dataset.testid = 'song-import-file';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    fileInput.value = '';
    await io.importFile(f);
  });
  const importBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Import') as HTMLButtonElement;
  importBtn.dataset.testid = 'song-import';
  importBtn.addEventListener('click', () => fileInput.click());

  // The same two routes the ✨ AI Prompt modal's step 3 uses — songs through the
  // file path above, presets through the manager's review step (paste-import.md).
  const pasteRoutes = {
    onSong: io.importBytes,
    onPresets: (parse: PresetParse) => bridge.openPresetImport(parse),
    bus, // so a pasted preset is checked against the registry too (REQ-deserialized-state-is-validated-never-cast)
  };
  const pasteBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Paste') as HTMLButtonElement;
  pasteBtn.dataset.testid = 'song-paste';
  pasteBtn.title = 'Paste song or preset JSON (e.g. an AI reply)';
  const openPaste = async (): Promise<void> => {
    const m = await loadSurface('the paste dialog', () => import('../components/paste-import'), () => void openPaste());
    m?.openPasteImportModal(pasteRoutes);
  };
  pasteBtn.addEventListener('click', () => void openPaste());
  // A file dropped anywhere on the window takes the same routes
  // (paste-import.md REQ-a-dropped-file-takes-the-paste-routes) — and is never left
  // to the browser, which would navigate away from the session.
  installFileDrop(pasteRoutes);

  const exportBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Export') as HTMLButtonElement;
  exportBtn.dataset.testid = 'song-export';
  const openExportSong = async (): Promise<void> => {
    const m = await loadSurface('the export dialog', () => import('../components/export-song-modal'), () => void openExportSong());
    m?.openExportSongModal({
      hasSamplerAudio: engine.sampler.buffers.some((b) => b != null),
      onExport: (kind, fmt) => { void io.runExport(kind, fmt); },
      // Copy Link: the current song as a #song= URL (song-share-link.md REQ-export-modal-copies-a-link).
      makeShareUrl: io.makeShareUrl,
    });
  };
  exportBtn.addEventListener('click', () => void openExportSong());

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
    song.startBlank();
  });

  ioRow.appendChild(el('span', styles.ioLabel!, 'Slot:'));
  ioRow.appendChild(dropdown.el);
  ioRow.appendChild(loadBtn);
  ioRow.appendChild(saveBtn);
  ioRow.appendChild(deleteBtn);
  ioRow.appendChild(importBtn);
  ioRow.appendChild(pasteBtn);
  ioRow.appendChild(exportBtn);
  ioRow.appendChild(newBtn);
  ioRow.appendChild(fileInput);

  const demosLabel = el('span', styles.ioLabel!, 'Demos:');
  // The ⓘ-mode badge for the whole row pins here (demo-library.md REQ-info-mode-badges-the-demo-row-once).
  demosLabel.dataset.help = 'song.demos';
  ioRow.appendChild(demosLabel);
  const mkDemoBtn = (name: string, onClick: () => void): HTMLButtonElement => {
    const d = el('button', `${switchStyles.root!} ${styles.demo!}`, name) as HTMLButtonElement;
    d.dataset.testid = `song-demo-${name}`;
    describeDemo(d, name);
    d.addEventListener('click', onClick);
    return d;
  };
  // Every demo by song name, whichever of the three sources it comes from
  // (song-mode.md REQ-drop-in-demos-are-fetched-on-click, v20). `demoNames()`
  // owns that order; everything routes through `loadDemo`, which knows which of
  // the three a name belongs to (the fetched ones need a user gesture anyway, so
  // decodeAudioData is unlocked — project-export.md REQ-zip-demos-auto-register).
  const demoButtonByName = new Map(
    demoNames().map((name) => [name, mkDemoBtn(name, () => { void demos.loadDemo(name); })] as const));
  const demoButtons = [...demoButtonByName.values()];
  // The blurbs join the tooltips once they have loaded, after boot
  // (demo-library.md REQ-the-blurbs-load-after-boot). A warm, not a gesture: a
  // failure leaves the facts alone (lazy-load-failure.md REQ-lazy-report-is-the-backstop).
  whenIdle(() => {
    import('../../state/demo-blurbs')
      .then(({ DEMO_BLURBS }) => {
        for (const [name, btn] of demoButtonByName) {
          const file = demoFileFor(name);
          const blurb = file ? DEMO_BLURBS[file] : undefined;
          if (blurb) describeDemo(btn, name, blurb);
        }
      })
      .catch(() => {});
  });

  // The loaded demo's ⓘ (demo-library.md REQ-the-loaded-demo-carries-an-info-button): ONE button,
  // moved to sit after whichever demo is loaded. A sibling, not a child — a
  // button cannot nest inside a button. Its library is a lazy chunk.
  const openDemoLibrary = async (): Promise<void> => {
    const m = await loadSurface('the demo library', () => import('../components/demo-library'), () => void openDemoLibrary());
    m?.openDemoLibrary({ loadDemo: demos.loadDemo, focus: song.loadedDemo });
  };
  const demoInfo = createButton({
    label: 'About this demo',
    icon: UI_ICONS.info,
    className: `${switchStyles.root!} ${styles.demoInfo!}`,
    testId: 'demo-loaded-info',
    onClick: () => void openDemoLibrary(),
  });
  song.onLoadedDemoChange((name) => {
    const btn = name === null ? undefined : demoButtonByName.get(name);
    if (!btn) {
      demoInfo.remove();
      return;
    }
    demoInfo.setAttribute('aria-label', `About ${name}`);
    demoInfo.title = `About ${name}`;
    btn.after(demoInfo);
  });
  // Only the first DEMO_ROW_LIMIT stay inline; the rest tuck behind an
  // "All Demos" toggle so the row doesn't crowd the panel (song-mode.md REQ-the-demo-row-overflows-into-a-menu).
  // `.io` is a wrapping flex, so a higher limit costs horizontal space only.
  for (const d of demoButtons.slice(0, DEMO_ROW_LIMIT)) ioRow.appendChild(d);
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
    ioRow.appendChild(moreBtn);
    ioRow.appendChild(overflow);
  }
  ioRow.appendChild(createAiPromptButton(bus, pasteRoutes));
  root.appendChild(ioRow);

  // ---- Sync + Audio ----
  // One wrapper so the two rows can pair up on a wide screen — Sync hard left,
  // Audio hard right — and dissolve back into two stacked rows below the
  // breakpoint (`display: contents`, song-mode.md REQ-sync-and-audio-pair-up). Sync leads in DOM
  // order, which is also the stacked order.
  const ioPair = el('div', styles.ioPair!);

  // ---- Audio (WAV / MP3) ----
  // Neither button writes a file any more: one opens the export options modal,
  // the other the Record window (audio-export.md REQ-export-opens-an-options-modal, record-window.md). The
  // Format switch below is therefore the GLOBAL DEFAULT both surfaces seed from
  // — each may override it for one use without writing back here.
  const aio = el('div', styles.io!);
  aio.appendChild(el('div', styles.sectionLabel!, 'Audio'));

  let fmt: ExportFormat = 'wav';

  // Names the format even though the modal can still override it: this button
  // sits a few pixels from the Song panel's other `Export` (the .json one), and
  // "as WAV" is what tells them apart at a glance (audio-export.md REQ-labels-echo-the-chosen-format).
  const expSongBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`) as HTMLButtonElement;
  expSongBtn.dataset.testid = 'song-export-audio';
  expSongBtn.title = 'Render the arrangement to audio — choose runs and format';
  expSongBtn.addEventListener('click', () => void openExportAudioModal(engine, fmt));

  const recLauncher = createRecordWindowLauncher(engine, () => fmt);
  // Reach was the original complaint: a floating window only solves it once
  // open, so Shift+R opens it from any tab (record-window.md REQ-shift-r-toggles-the-record-window).
  bridge.toggleRecordWindow = recLauncher.toggle;

  const syncExportLabel = (): void => {
    expSongBtn.textContent = `Export Song as ${fmt.toUpperCase()}…`;
  };

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
      syncExportLabel();
    });
    fmtSel.appendChild(b);
  });
  syncExportLabel();

  const fmtLabel = el('span', styles.ioLabel!, 'Format:');
  fmtLabel.title = 'The default format for exports and recordings — each can override it';
  aio.appendChild(fmtLabel);
  aio.appendChild(fmtSel);
  aio.appendChild(expSongBtn);
  aio.appendChild(recLauncher.el);

  // ---- Transport sync (MIDI master/slave + WiFi) ----
  ioPair.appendChild(buildSyncSection(engine.sync, engine.rtcSync));
  ioPair.appendChild(aio);
  root.appendChild(ioPair);

  return {
    el: root,
    loadDemo: demos.loadDemo,
    importBytes: io.importBytes,
    importFile: io.importFile,
    loadedDemo: () => song.loadedDemo,
  };
}
