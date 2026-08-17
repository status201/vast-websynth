import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import type { PatternUndo } from '../../state/pattern-undo';
import type { UiBridge } from '../ui-bridge';
import { createUndoButton } from '../components/undo-button';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { fxGroup } from '../components/fx-group';
import { StepButton } from '../components/step-button';
import {
  bankBarFor, wrapGridWithRestOverlay, wirePlayhead, playheadRulerFor, laneControlsFor, laneMeterControlsFor, GridCursor, clearMenuFor,
  samplerSlotClearRow, VisibilityGate, type MachinePanel,
} from './step-panel-scaffold';
import { attachGridGestures } from '../components/grid-gestures';
import type { RecordSoundOptions } from '../components/record-sound-modal';
import { alertDialog } from '../components/dialog';
import { StepSettingsEditor, paintTriggerCell } from '../components/step-settings';
import { audioBufferToCaptured } from '../../audio/recorder/audio-buffer';
import { SAMPLER_SLOT_COUNT, SAMPLER_SLOT_LABELS } from '../../state/patterns';
import { ALL_CELLS, bindLaneGrid } from '../lane-grid';
import layout from '../styles/layout.module.css';
import drumStyles from '../styles/drum.module.css';
import samplerStyles from '../styles/sampler.module.css';
import editStyles from '../styles/step-settings.module.css';

/**
 * The recorder/editor is ~19 kB of modal that a player reaching for the sampler
 * may never open, so it loads on the click that opens it
 * (runtime-performance.md REQ-1). Both call sites go through here.
 */
async function openRecordSoundModal(engine: StudioApi, opts?: RecordSoundOptions): Promise<void> {
  const m = await import('../components/record-sound-modal');
  m.openRecordSoundModal(engine, opts);
}

export function buildSamplerPanel(
  bus: ParamBus,
  engine: StudioApi,
  undo: PatternUndo,
  bridge: UiBridge,
): MachinePanel {
  const root = document.createElement('div');
  root.className = layout.patternPanel!;

  // ---- Header ----
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'sampler.on', 'sampler').el);
  // Chain / Mute / Solo, right after the machine switch — the same three
  // controls the Song tab's lane card carries (machine-status.md REQ-9).
  header.appendChild(laneControlsFor(bus, engine, 'sampler', bridge).el);
  header.appendChild(laneMeterControlsFor(bus, 'sampler').el);
  header.appendChild(new Knob({ bus, paramId: 'sampler.master', label: 'MASTER' }).el);
  const bankBar = bankBarFor(engine, 'sampler');
  header.appendChild(bankBar.el);
  header.appendChild(createUndoButton(undo, 'sampler'));
  // The row item is labelled with the slot's filename, so it removes the file
  // too — steps, name and buffer (sampler.md REQ-9). `Clear bank` stays
  // step-only: names are shared by all four banks.
  header.appendChild(clearMenuFor(engine, 'sampler', undo,
    () => [samplerSlotClearRow(engine, undo, cursor.selRow)]));

  const recBtn = document.createElement('button');
  recBtn.className = `${samplerStyles.rec!}`;
  recBtn.dataset.testid = 'sampler-record';
  recBtn.textContent = 'Record a sound';
  recBtn.title = 'Record a sound from your microphone';
  recBtn.addEventListener('click', () => void openRecordSoundModal(engine));
  header.appendChild(recBtn);

  // One cluster so the header breaks between machine controls and FX rather
  // than mid-cluster (responsive-machine-header.md).
  const fx = document.createElement('div');
  fx.className = layout.fxCluster!;
  fx.appendChild(fxGroup(bus, 'DIST', 'fx.sampler.dist', [
    { id: 'fx.sampler.dist.drive', label: 'DRIVE' },
    { id: 'fx.sampler.dist.tone', label: 'TONE' },
    { id: 'fx.sampler.dist.mix', label: 'MIX' },
  ]));
  fx.appendChild(fxGroup(bus, 'PHASER', 'fx.sampler.phaser', [
    { id: 'fx.sampler.phaser.rate', label: 'RATE' },
    { id: 'fx.sampler.phaser.depth', label: 'DEPTH' },
    { id: 'fx.sampler.phaser.feedback', label: 'FB' },
    { id: 'fx.sampler.phaser.mix', label: 'MIX' },
  ]));
  fx.appendChild(fxGroup(bus, 'DELAY', 'fx.sampler.delay', [
    { id: 'fx.sampler.delay.time', label: 'TIME' },
    { id: 'fx.sampler.delay.feedback', label: 'FB' },
    { id: 'fx.sampler.delay.mix', label: 'MIX' },
  ]));
  fx.appendChild(fxGroup(bus, 'REVERB', 'fx.sampler.reverb', [
    { id: 'fx.sampler.reverb.size', label: 'SIZE' },
    { id: 'fx.sampler.reverb.damp', label: 'DAMP' },
    { id: 'fx.sampler.reverb.mix', label: 'MIX' },
  ]));
  // Last, mirroring the sampler chain order (sidechain-ducking.md REQ-8).
  fx.appendChild(fxGroup(bus, 'DUCK', 'fx.sampler.duck', [
    { id: 'fx.sampler.duck.amount', label: 'AMT' },
    { id: 'fx.sampler.duck.attack', label: 'ATK' },
    { id: 'fx.sampler.duck.release', label: 'REL' },
    { id: 'fx.sampler.duck.src', label: 'SRC' },
  ]));
  header.appendChild(fx);

  root.appendChild(header);

  // Declared here rather than beside wirePlayhead below, because the ruler is
  // built before the grid and needs the same gate.
  const gate = new VisibilityGate();

  // ---- Transport-position ruler (transport-position.md REQ-9) ----
  // Outside the rest-overlay wrapper on purpose: a rest bar dims the *pattern*,
  // but where the transport is stays readable.
  const ruler = playheadRulerFor(engine, bus, 'sampler', gate);
  const rulerRow = document.createElement('div');
  rulerRow.className = drumStyles.row!;
  const rulerCtrls = document.createElement('div');
  rulerCtrls.className = drumStyles.rowCtrls!;
  rulerCtrls.appendChild(ruler.barEl);
  rulerRow.appendChild(rulerCtrls);
  ruler.cellsEl.classList.add(drumStyles.cells!);
  rulerRow.appendChild(ruler.cellsEl);
  root.appendChild(rulerRow);

  // ---- Slot rows ----
  const grid = document.createElement('div');
  grid.className = drumStyles.grid!;
  const { el: gridWrap, restOverlay } = wrapGridWithRestOverlay(engine, 'sampler', bankBar, grid);
  root.appendChild(gridWrap);

  const stepBtns: StepButton[][] = [];
  const cellRows: HTMLElement[] = [];
  const labels: HTMLButtonElement[] = [];
  const editBtns: HTMLButtonElement[] = [];

  // Selection cursor for the per-step edit row (one cell across the grid).
  const cursor = new GridCursor(stepBtns, () => {
    renderSelected();
    editor.refresh();
  });
  const setSelected = (sl: number, st: number): void => cursor.set(sl, st);

  const refreshLabel = (slot: number): void => {
    const lbl = labels[slot];
    if (!lbl) return;
    const name = engine.patterns.sampleNames[slot] ?? null;
    const loaded = engine.sampler.buffers[slot] != null;
    lbl.textContent = name ?? `${SAMPLER_SLOT_LABELS[slot] ?? `S${slot + 1}`} …`;
    lbl.classList.toggle('needs-reload', name != null && !loaded);
    lbl.title = name
      ? (loaded ? 'Click to audition' : 'Reload this audio file (not saved in songs)')
      : 'Load a WAV/MP3 file';
    const editBtn = editBtns[slot];
    if (editBtn) editBtn.style.display = loaded ? '' : 'none';
  };

  for (let t = 0; t < SAMPLER_SLOT_COUNT; t++) {
    const slot = t;
    const row = document.createElement('div');
    row.className = drumStyles.row!;

    const ctrls = document.createElement('div');
    ctrls.className = drumStyles.rowCtrls!;
    ctrls.style.width = '210px';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.wav,.mp3';
    fileInput.style.display = 'none';
    fileInput.dataset.testid = `sampler-file-${slot}`;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const buf = await engine.ctx.decodeAudioData(await f.arrayBuffer());
        engine.sampler.setBuffer(slot, buf);
        engine.patterns.setSampleName(slot, f.name);
      } catch {
        await alertDialog({ title: 'Load failed', message: 'Unsupported or corrupt audio file.' });
      }
      fileInput.value = '';
    });

    const loadBtn = document.createElement('button');
    loadBtn.className = samplerStyles.load!;
    loadBtn.dataset.testid = `sampler-load-${slot}`;
    loadBtn.textContent = 'Load';
    loadBtn.title = 'Load a WAV/MP3 file into this slot';
    loadBtn.addEventListener('click', () => fileInput.click());
    ctrls.appendChild(loadBtn);

    const label = document.createElement('button');
    label.className = samplerStyles.name!;
    label.dataset.testid = `sampler-name-${slot}`;
    label.addEventListener('click', () => engine.sampler.triggerSlot(slot, 0.9));
    labels[slot] = label;
    ctrls.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.className = samplerStyles.edit!;
    editBtn.dataset.testid = `sampler-edit-${slot}`;
    editBtn.textContent = '✎';
    editBtn.title = 'Edit this sample';
    editBtn.style.display = 'none';
    editBtn.addEventListener('click', () => {
      const buf = engine.sampler.buffers[slot];
      if (!buf) return;
      void openRecordSoundModal(engine, { slot, source: audioBufferToCaptured(buf) });
    });
    editBtns[slot] = editBtn;
    ctrls.appendChild(editBtn);

    const mute = new Switch(bus, `sampler.t${slot}.mute`, 'mute');
    mute.el.classList.add(drumStyles.mute!);
    ctrls.appendChild(mute.el);

    ctrls.appendChild(fileInput);
    row.appendChild(ctrls);

    const cells = document.createElement('div');
    cells.className = drumStyles.cells!;
    cellRows.push(cells);
    const trackBtns: StepButton[] = [];
    // Every cell is built; `bindLaneGrid` below decides which are live and where
    // the beat accents fall, so the meter owns both (meter.md REQ-8/REQ-11).
    for (let s = 0; s < ALL_CELLS; s++) {
      const cell = engine.patterns.sampler[slot]![s]!;
      const sb = new StepButton('');
      sb.el.dataset.testid = `sampler-step-${slot}-${s}`;
      sb.el.classList.add(StepButton.drumCellClass);
      paintTriggerCell(sb, cell);
      cells.appendChild(sb.el);
      trackBtns.push(sb);
    }
    stepBtns.push(trackBtns);
    row.appendChild(cells);
    grid.appendChild(row);

    refreshLabel(slot);
  }

  // Column count, live cells and beat accents, all from the meter. Bound after
  // the rows exist, because it paints immediately. Not unsubscribed: the panel
  // is built once and lives as long as the page does.
  bindLaneGrid(bus, 'sampler', () => cellRows, () => stepBtns);

  // The shared gesture model (step-grid-editing.md): tap toggles, drag paints,
  // long-press / right-click selects only. Attached after the rows are built so
  // every cell exists, and before the first repaint.
  attachGridGestures({
    cells: stepBtns.map((row) => row.map((sb) => sb.el)),
    isOn: (sl, s) => engine.patterns.sampler[sl]?.[s]?.on ?? false,
    onToggle: (sl, s, on) => engine.patterns.setSamplerCell(sl, s, { on }),
    onSelect: setSelected,
    heldClass: StepButton.heldClass,
  });

  // ---- Per-step edit row (shared component; below the grid) ----
  const editor = new StepSettingsEditor({
    testidPrefix: 'sampler',
    get: () => engine.patterns.sampler[cursor.selRow]?.[cursor.selCol],
    set: (p) => engine.patterns.setSamplerCell(cursor.selRow, cursor.selCol, p),
  });
  const selectedLabel = document.createElement('div');
  selectedLabel.className = editStyles.selectedLabel!;
  const renderSelected = () => {
    const name = engine.patterns.sampleNames[cursor.selRow] ?? SAMPLER_SLOT_LABELS[cursor.selRow] ?? `S${cursor.selRow + 1}`;
    selectedLabel.textContent = `${name} · step ${cursor.selCol + 1}`;
  };
  editor.el.insertBefore(selectedLabel, editor.el.firstChild);
  root.appendChild(editor.el);
  setSelected(0, 0);

  const highlighter = wirePlayhead(engine, 'sampler', stepBtns, restOverlay, gate);

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onSamplerBankChange((bank) => {
    highlighter.clear();
    for (let s = 0; s < SAMPLER_SLOT_COUNT; s++) {
      for (let i = 0; i < ALL_CELLS; i++) {
        const sb = stepBtns[s]?.[i];
        if (sb) paintTriggerCell(sb, bank[s]![i]!);
      }
    }
    editor.refresh();
  });

  // Live step edit updates
  engine.patterns.onSamplerChange((slot, step, cell) => {
    const sb = stepBtns[slot]?.[step];
    if (sb) paintTriggerCell(sb, cell);
    if (slot === cursor.selRow && step === cursor.selCol) editor.refresh();
  });

  // Filename / load-state changes
  engine.patterns.onSampleMetaChange((slot) => {
    refreshLabel(slot);
    if (slot === cursor.selRow) renderSelected();
  });

  return {
    el: root,
    gate,
    clearSelectedStep: () => engine.patterns.setSamplerCell(cursor.selRow, cursor.selCol, { on: false }),
  };
}
