import type { ParamBus } from '../../state/params';
import type { PresetSession } from '../../state/preset-session';
import type { XyPadStore } from '../../state/xy-pad';
import type { StudioApi } from '../studio-api';
import type { ChainLane } from '../../audio/transport/arrangement';
import type { ExportFormat } from '../../audio/recorder/recorder-controller';
import { Knob } from '../components/knob';
import { Switch } from '../components/switch';
import { Dropdown } from '../components/dropdown';
import { audibleLanes, LANE_IDS, type LaneId, type LaneFlags } from '../../audio/transport/lane-mix';
import { fxGroup } from '../components/fx-group';
import { GrMeter } from '../components/gr-meter';
import { createXyPadWindowController } from '../components/xy-pad-window';
import { buildLiveFxControls, xyPadLaunchButton, createLiveFxWindowLauncher } from '../components/live-fx';
import { createAiPromptButton } from '../components/ai-prompt';
import { buildSyncSection } from '../components/sync-section';
import { confirmDialog, promptDialog, alertDialog } from '../components/dialog';
import { BANK_LABELS, REST, SEQ_LENGTH, DRUM_TRACK_COUNT, SAMPLER_SLOT_COUNT, TRIGGER_CELL_DEFAULTS } from '../../state/patterns';
import { restIcon } from '../components/rest-glyph';
import switchStyles from '../styles/switch.module.css';
import bankStyles from '../styles/bank-bar.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import styles from '../styles/song-panel.module.css';
import layout from '../styles/layout.module.css';
import { Song, DEMO_SONGS, type SongFile } from '../../state/song';

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface SongPanel {
  el: HTMLElement;
  /** Load a demo by name AND sync the slot dropdown (shared with the demo buttons). */
  loadDemo: (name: string) => void;
}

export function buildSongPanel(bus: ParamBus, engine: StudioApi, session: PresetSession, xy: XyPadStore): SongPanel {
  const root = el('div', `${layout.patternPanel!} ${styles.panel!}`);

  // Apply a song AND label the selector with its name (all apply sites route
  // through here so the header reflects the loaded song).
  const applySong = (file: SongFile): void => {
    Song.apply(file, bus, engine.patterns, engine.arrangement, xy);
    session.setActive(file.name);
  };

  // ---- Chain lanes (each with DJ mute / solo / volume) ----
  const chains = el('div', styles.chains!);
  const laneEls: Record<LaneId, HTMLElement> = {
    seq: buildChainLane(
      'Sequencer', 'seq', bus, engine.arrangement.seq,
      (s, en) => engine.arrangement.setSeqChain(s, en),
      () => engine.arrangement.seqChainPos, engine),
    drum: buildChainLane(
      'Drums', 'drum', bus, engine.arrangement.drum,
      (s, en) => engine.arrangement.setDrumChain(s, en),
      () => engine.arrangement.drumChainPos, engine),
    sampler: buildChainLane(
      'Sampler', 'sampler', bus, engine.arrangement.sampler,
      (s, en) => engine.arrangement.setSamplerChain(s, en),
      () => engine.arrangement.samplerChainPos, engine),
  };
  for (const id of LANE_IDS) chains.appendChild(laneEls[id]);
  root.appendChild(chains);

  // Dim a lane card whenever it is silenced — by its own mute or by another
  // lane's solo. Uses the same `audibleLanes` rule the engine applies, so the
  // visual can never disagree with what you hear.
  const flag = (suffix: string): LaneFlags => ({
    seq: bus.get(`seq.${suffix}`) >= 0.5,
    drum: bus.get(`drum.${suffix}`) >= 0.5,
    sampler: bus.get(`sampler.${suffix}`) >= 0.5,
  });
  const refreshSilenced = (): void => {
    const audible = audibleLanes(flag('mute'), flag('solo'));
    for (const id of LANE_IDS) laneEls[id].classList.toggle(styles.silenced!, !audible[id]);
  };
  for (const id of LANE_IDS) {
    bus.subscribe(`${id}.mute`, refreshSilenced);
    bus.subscribe(`${id}.solo`, refreshSilenced);
  }

  // ---- Live DJ FX ----
  // One shared XY Pad window controller: the Song panel's launcher AND the LIVE FX
  // window's launcher toggle the SAME window (never two).
  const xyWin = createXyPadWindowController(bus, xy);

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

  // Shared demo-load: apply the song AND sync the slot dropdown. Used by the
  // demo buttons and by the guided tour (so the dropdown reflects what loaded).
  const loadDemo = (name: string): void => {
    const file = DEMO_SONGS[name];
    if (!file) return;
    applySong(file);
    refreshList();
    dropdown.setValue(name);
  };

  const loadBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Load') as HTMLButtonElement;
  loadBtn.dataset.testid = 'song-load';
  loadBtn.addEventListener('click', () => {
    const f = Song.loadSlot(dropdown.value);
    if (f) applySong(f);
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
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';
  fileInput.dataset.testid = 'song-import-file';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const res = await Song.parseFile(f);
    if (!res.ok) {
      const shown = res.errors.slice(0, 8);
      const more = res.errors.length - shown.length;
      await alertDialog({
        title: 'Import failed',
        message: 'Could not import song:\n• ' + shown.join('\n• ') + (more > 0 ? `\n…and ${more} more` : ''),
      });
      fileInput.value = '';
      return;
    }
    const song = res.file;
    try {
      applySong(song);
    } catch (e) {
      await alertDialog({
        title: 'Import failed',
        message: 'Song imported but failed to apply: ' + (e as Error).message,
      });
      fileInput.value = '';
      return;
    }
    Song.saveSlot(song.name, song);
    refreshList();
    dropdown.setValue(song.name);
    fileInput.value = '';
  });
  const importBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Import') as HTMLButtonElement;
  importBtn.dataset.testid = 'song-import';
  importBtn.addEventListener('click', () => fileInput.click());

  const exportBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Export') as HTMLButtonElement;
  exportBtn.dataset.testid = 'song-export';
  exportBtn.addEventListener('click', () => {
    const name = dropdown.value || 'My Song';
    Song.download(Song.capture(bus, engine.patterns, engine.arrangement, name, xy));
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
    engine.patterns.restore({
      seqBanks: emptySeqBanks(),
      drumBanks: emptyDrumBanks(),
      samplerBanks: emptySamplerBanks(),
      sampleNames: Array(SAMPLER_SLOT_COUNT).fill(null),
    });
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) engine.sampler.setBuffer(i, null);
    engine.arrangement.setSeqChain([0], false);
    engine.arrangement.setDrumChain([0], false);
    engine.arrangement.setSamplerChain([0], false);
  });

  io.appendChild(el('span', styles.ioLabel!, 'Slot:'));
  io.appendChild(dropdown.el);
  io.appendChild(loadBtn);
  io.appendChild(saveBtn);
  io.appendChild(importBtn);
  io.appendChild(exportBtn);
  io.appendChild(newBtn);
  io.appendChild(fileInput);

  io.appendChild(el('span', styles.ioLabel!, 'Demos:'));
  for (const name of Object.keys(DEMO_SONGS)) {
    const d = el('button', `${switchStyles.root!} ${styles.demo!}`, name) as HTMLButtonElement;
    d.dataset.testid = `song-demo-${name}`;
    d.addEventListener('click', () => loadDemo(name));
    io.appendChild(d);
  }
  io.appendChild(createAiPromptButton(bus));
  root.appendChild(io);

  // ---- Audio export (WAV / MP3) ----
  const aio = el('div', styles.io!);
  aio.appendChild(el('div', styles.sectionLabel!, 'Audio'));

  let fmt: ExportFormat = 'wav';
  const fmtSel = el('div', segmentedStyles.root!);
  ([['WAV', 'wav'], ['MP3', 'mp3']] as Array<[string, ExportFormat]>).forEach(([lbl, f], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = lbl;
    if (i === 0) b.classList.add('active');
    b.addEventListener('click', () => {
      fmt = f;
      for (const c of Array.from(fmtSel.children)) c.classList.remove('active');
      b.classList.add('active');
    });
    fmtSel.appendChild(b);
  });

  const expSongBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Export Song') as HTMLButtonElement;
  expSongBtn.dataset.testid = 'song-export-audio';
  expSongBtn.title = 'Render one full pass of the arrangement, then download';
  expSongBtn.addEventListener('click', () => engine.recorder.exportSong(fmt));

  const recBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Record') as HTMLButtonElement;
  recBtn.dataset.testid = 'song-record';
  recBtn.title = 'Free-form record toggle (starts the transport if stopped)';
  recBtn.addEventListener('click', () => engine.recorder.toggleManual(fmt));
  engine.recorder.onState((rec) => {
    recBtn.classList.toggle('on', rec);
    recBtn.textContent = rec ? 'Stop' : 'Record';
  });

  aio.appendChild(el('span', styles.ioLabel!, 'Format:'));
  aio.appendChild(fmtSel);
  aio.appendChild(expSongBtn);
  aio.appendChild(recBtn);
  root.appendChild(aio);

  // ---- Transport sync (MIDI master/slave + WiFi) ----
  root.appendChild(buildSyncSection(engine.sync, engine.rtcSync));

  return { el: root, loadDemo };
}

function emptySamplerBanks() {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: SAMPLER_SLOT_COUNT }, () =>
      Array.from({ length: SEQ_LENGTH }, () => ({ ...TRIGGER_CELL_DEFAULTS }))));
}

function buildChainLane(
  title: string,
  prefix: LaneId,
  bus: ParamBus,
  lane: ChainLane,
  setChain: (steps: number[], enabled: boolean) => void,
  getPos: () => number,
  engine: StudioApi,
): HTMLElement {
  const root = el('div', styles.lane!);
  root.dataset.testid = `song-lane-${prefix}`;

  const head = el('div', styles.head!);
  head.appendChild(el('div', styles.title!, title));

  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.className = `${switchStyles.root!} ${styles.ctl!}`;
  enableBtn.innerHTML = `<span class="${switchStyles.led!}"></span><span class="${switchStyles.label!}">Chain</span>`;
  enableBtn.addEventListener('click', () => setChain([...lane.steps], !lane.enabled));
  head.appendChild(enableBtn);
  root.appendChild(head);

  // DJ mixer strip: mute / solo / volume, so the lane is operable from the Song
  // tab without switching machines. All three bind straight to ParamBus, so
  // they stay in sync with the per-machine panels and persist with the song.
  const mix = el('div', styles.mix!);
  mix.appendChild(new Switch(bus, `${prefix}.mute`, 'Mute').el);
  mix.appendChild(new Switch(bus, `${prefix}.solo`, 'Solo').el);
  const vol = new Knob({ bus, paramId: `${prefix}.master`, label: 'Vol', size: 34 });
  vol.el.classList.add(styles.vol!);
  mix.appendChild(vol.el);
  root.appendChild(mix);

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

function emptySeqBanks() {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: SEQ_LENGTH }, (_, i) => ({ on: false, note: 60 + (i % 8), velocity: 0.8, gate: 0.5, prob: 1, ratchet: 1, tie: false })));
}
function emptyDrumBanks() {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: DRUM_TRACK_COUNT }, () =>
      Array.from({ length: SEQ_LENGTH }, () => ({ ...TRIGGER_CELL_DEFAULTS }))));
}
