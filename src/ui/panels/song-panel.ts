import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import type { ChainLane } from '../../audio/transport/arrangement';
import type { ExportFormat } from '../../audio/recorder/recorder-controller';
import { Knob } from '../components/knob';
import { Dropdown } from '../components/dropdown';
import { createAiPromptButton } from '../components/ai-prompt';
import { BANK_LABELS, SEQ_LENGTH, DRUM_TRACK_COUNT, SAMPLER_SLOT_COUNT } from '../../state/patterns';
import switchStyles from '../styles/switch.module.css';
import bankStyles from '../styles/bank-bar.module.css';
import styles from '../styles/song-panel.module.css';
import layout from '../styles/layout.module.css';
import { Song, DEMO_SONGS } from '../../state/song';

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function momentary(label: string, on: () => void, off: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${switchStyles.root!} ${styles.djBtn!}`;
  b.textContent = label;
  const start = (e: Event) => { e.preventDefault(); if (!b.classList.contains('on')) { b.classList.add('on'); on(); } };
  const end = () => { if (b.classList.contains('on')) { b.classList.remove('on'); off(); } };
  b.addEventListener('pointerdown', start);
  b.addEventListener('pointerup', end);
  b.addEventListener('pointerleave', end);
  b.addEventListener('pointercancel', end);
  return b;
}

export function buildSongPanel(bus: ParamBus, engine: Engine): HTMLElement {
  const root = el('div', `${layout.patternPanel!} ${styles.panel!}`);

  // ---- Chain lanes ----
  const chains = el('div', styles.chains!);
  chains.appendChild(buildChainLane(
    'Sequencer', engine.arrangement.seq,
    (s, en) => engine.arrangement.setSeqChain(s, en),
    () => engine.arrangement.seqChainPos, engine));
  chains.appendChild(buildChainLane(
    'Drums', engine.arrangement.drum,
    (s, en) => engine.arrangement.setDrumChain(s, en),
    () => engine.arrangement.drumChainPos, engine));
  chains.appendChild(buildChainLane(
    'Sampler', engine.arrangement.sampler,
    (s, en) => engine.arrangement.setSamplerChain(s, en),
    () => engine.arrangement.samplerChainPos, engine));
  root.appendChild(chains);

  // ---- Live DJ FX ----
  const fx = el('div', styles.djFx!);
  fx.appendChild(el('div', styles.sectionLabel!, 'Live FX'));

  fx.appendChild(momentary('Fill', () => engine.perf.setFill(true), () => engine.perf.setFill(false)));

  const stutterWrap = el('div', styles.stutter!);
  stutterWrap.appendChild(momentary('Stutter',
    () => engine.perf.setStutter(true), () => engine.perf.setStutter(false)));
  const sizes = el('div', `${styles.stutterSize!}`);
  ([['1', 1], ['1/8', 2], ['1/4', 4]] as Array<[string, number]>).forEach(([lbl, n], i) => {
    const sb = document.createElement('button');
    sb.type = 'button';
    sb.textContent = lbl;
    if (i === 1) sb.classList.add('active');
    sb.addEventListener('click', () => {
      engine.perf.setStutterSize(n);
      for (const c of Array.from(sizes.children)) c.classList.remove('active');
      sb.classList.add('active');
    });
    sizes.appendChild(sb);
  });
  stutterWrap.appendChild(sizes);
  fx.appendChild(stutterWrap);

  fx.appendChild(momentary('Drop', () => engine.perf.setDrop(true), () => engine.perf.setDrop(false)));
  fx.appendChild(momentary('Tape Stop',
    () => engine.perf.setTapeStop(true), () => engine.perf.setTapeStop(false)));
  fx.appendChild(new Knob({ bus, paramId: 'fx.djfilter', label: 'DJ FLT' }).el);
  root.appendChild(fx);

  // ---- Song I/O ----
  const io = el('div', styles.io!);
  io.appendChild(el('div', styles.sectionLabel!, 'Song'));

  const dropdown = new Dropdown(Song.list(), Song.list()[0] ?? '');
  const refreshList = () => dropdown.setOptions(Song.list());

  const loadBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Load') as HTMLButtonElement;
  loadBtn.addEventListener('click', () => {
    const f = Song.loadSlot(dropdown.value);
    if (f) Song.apply(f, bus, engine.patterns, engine.arrangement);
  });

  const saveBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Save') as HTMLButtonElement;
  saveBtn.addEventListener('click', () => {
    const name = prompt('Song name:', dropdown.value || 'My Song');
    if (!name) return;
    const file = Song.capture(bus, engine.patterns, engine.arrangement, name);
    Song.saveSlot(name, file);
    Song.download(file);
    refreshList();
    dropdown.setValue(name);
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const song = await Song.readFile(f);
    if (!song) { alert('Not a valid WebSynth song file.'); return; }
    Song.apply(song, bus, engine.patterns, engine.arrangement);
    Song.saveSlot(song.name, song);
    refreshList();
    dropdown.setValue(song.name);
    fileInput.value = '';
  });
  const importBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Import') as HTMLButtonElement;
  importBtn.addEventListener('click', () => fileInput.click());

  const exportBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Export') as HTMLButtonElement;
  exportBtn.addEventListener('click', () => {
    const name = dropdown.value || 'My Song';
    Song.download(Song.capture(bus, engine.patterns, engine.arrangement, name));
  });

  const newBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'New') as HTMLButtonElement;
  newBtn.addEventListener('click', () => {
    if (!confirm('Clear all banks and chains?')) return;
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
    d.addEventListener('click', () => {
      Song.apply(DEMO_SONGS[name]!, bus, engine.patterns, engine.arrangement);
      refreshList();
      dropdown.setValue(name);
    });
    io.appendChild(d);
  }
  io.appendChild(createAiPromptButton(bus));
  root.appendChild(io);

  // ---- Audio export (WAV / MP3) ----
  const aio = el('div', styles.io!);
  aio.appendChild(el('div', styles.sectionLabel!, 'Audio'));

  let fmt: ExportFormat = 'wav';
  const fmtSel = el('div', 'segmented');
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
  expSongBtn.title = 'Render one full pass of the arrangement, then download';
  expSongBtn.addEventListener('click', () => engine.recorder.exportSong(fmt));

  const recBtn = el('button', `${switchStyles.root!} ${styles.ctl!}`, 'Record') as HTMLButtonElement;
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

  return root;
}

function emptySamplerBanks() {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: SAMPLER_SLOT_COUNT }, () =>
      Array.from({ length: SEQ_LENGTH }, () => ({ on: false, velocity: 0.85 }))));
}

function buildChainLane(
  title: string,
  lane: ChainLane,
  setChain: (steps: number[], enabled: boolean) => void,
  getPos: () => number,
  engine: Engine,
): HTMLElement {
  const root = el('div', styles.lane!);

  const head = el('div', styles.head!);
  head.appendChild(el('div', styles.title!, title));

  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.className = `${switchStyles.root!} ${styles.ctl!}`;
  enableBtn.innerHTML = `<span class="${switchStyles.led!}"></span><span class="${switchStyles.label!}">Chain</span>`;
  enableBtn.addEventListener('click', () => setChain([...lane.steps], !lane.enabled));
  head.appendChild(enableBtn);
  root.appendChild(head);

  const chips = el('div', styles.chips!);
  root.appendChild(chips);

  let sel = -1;

  const controls = el('div', styles.controls!);
  const addRow = el('div', styles.addRow!);
  BANK_LABELS.forEach((label, i) => {
    const a = el('button', `${bankStyles.btn!} ${styles.add!}`, '') as HTMLButtonElement;
    a.innerHTML = `<span class="${bankStyles.letter!}">${label}</span>`;
    a.addEventListener('click', () => { setChain([...lane.steps, i], lane.enabled); });
    addRow.appendChild(a);
  });
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
  controls.appendChild(mk('Clear', () => { sel = -1; setChain([0], lane.enabled); }));
  root.appendChild(controls);

  const render = () => {
    enableBtn.classList.toggle('on', lane.enabled);
    if (sel >= lane.steps.length) sel = -1;
    chips.innerHTML = '';
    const pos = getPos();
    lane.steps.forEach((b, idx) => {
      const c = el('button', styles.chip!, BANK_LABELS[b] ?? '?') as HTMLButtonElement;
      if (idx === sel) c.classList.add('sel');
      if (lane.enabled && idx === pos) c.classList.add('playing');
      c.addEventListener('click', () => { sel = idx === sel ? -1 : idx; render(); });
      chips.appendChild(c);
    });
  };

  engine.arrangement.onChange(render);
  render();
  return root;
}

function emptySeqBanks() {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: SEQ_LENGTH }, (_, i) => ({ on: false, note: 60 + (i % 8), velocity: 0.8, gate: 0.5 })));
}
function emptyDrumBanks() {
  return Array.from({ length: 4 }, () =>
    Array.from({ length: DRUM_TRACK_COUNT }, () =>
      Array.from({ length: SEQ_LENGTH }, () => ({ on: false, velocity: 0.85 }))));
}
