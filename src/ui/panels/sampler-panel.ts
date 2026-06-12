import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { StepButton } from '../components/step-button';
import { PlayheadHighlighter } from '../components/playhead-highlighter';
import { BankBar } from '../components/bank-bar';
import { openRecordSoundModal } from '../components/record-sound-modal';
import { StepSettingsEditor, stepTitle } from '../components/step-settings';
import { audioBufferToCaptured } from '../../audio/recorder/audio-buffer';
import { SAMPLER_SLOT_COUNT, SAMPLER_SLOT_LABELS, SEQ_LENGTH, type SamplerStep } from '../../state/patterns';
import layout from '../styles/layout.module.css';
import drumStyles from '../styles/drum.module.css';
import samplerStyles from '../styles/sampler.module.css';
import editStyles from '../styles/step-settings.module.css';

// Repaint a sampler cell: lit state, the per-step settings viz and a tooltip.
function paintCell(sb: StepButton, cell: SamplerStep): void {
  sb.setOn(cell.on);
  sb.setViz(cell);
  sb.el.title = stepTitle(cell);
}

export function buildSamplerPanel(bus: ParamBus, engine: Engine): HTMLElement {
  const root = document.createElement('div');
  root.className = layout.patternPanel!;

  // ---- Header ----
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'sampler.on', 'sampler').el);
  header.appendChild(new Knob({ bus, paramId: 'sampler.master', label: 'MASTER' }).el);
  header.appendChild(new BankBar({
    getEdit: () => engine.patterns.samplerEditBank,
    setEdit: (i) => engine.patterns.setSamplerEditBank(i),
    copy: (f, t) => engine.patterns.copySamplerBank(f, t),
    onEditChange: (fn) => engine.patterns.onEditBankChange(fn),
    getPlay: () => engine.arrangement.samplerPlayBank,
    onPlayChange: (fn) => engine.arrangement.onChange(fn),
    hasContent: (i) => engine.patterns.samplerBanks[i]!.some((sl) => sl.some((c) => c.on)),
    onContentChange: (fn) => engine.patterns.onSamplerChange(fn),
    testidPrefix: 'sampler',
  }).el);

  const recBtn = document.createElement('button');
  recBtn.className = `${samplerStyles.rec!}`;
  recBtn.dataset.testid = 'sampler-record';
  recBtn.textContent = 'Record a sound';
  recBtn.title = 'Record a sound from your microphone';
  recBtn.addEventListener('click', () => openRecordSoundModal(engine));
  header.appendChild(recBtn);
  header.appendChild(fxGroup(bus, 'DIST', 'fx.sampler.dist', [
    { id: 'fx.sampler.dist.drive', label: 'DRIVE' },
    { id: 'fx.sampler.dist.tone', label: 'TONE' },
    { id: 'fx.sampler.dist.mix', label: 'MIX' },
  ]));
  header.appendChild(fxGroup(bus, 'PHASER', 'fx.sampler.phaser', [
    { id: 'fx.sampler.phaser.rate', label: 'RATE' },
    { id: 'fx.sampler.phaser.depth', label: 'DEPTH' },
    { id: 'fx.sampler.phaser.feedback', label: 'FB' },
    { id: 'fx.sampler.phaser.mix', label: 'MIX' },
  ]));
  header.appendChild(fxGroup(bus, 'DELAY', 'fx.sampler.delay', [
    { id: 'fx.sampler.delay.time', label: 'TIME' },
    { id: 'fx.sampler.delay.feedback', label: 'FB' },
    { id: 'fx.sampler.delay.mix', label: 'MIX' },
  ]));
  header.appendChild(fxGroup(bus, 'REVERB', 'fx.sampler.reverb', [
    { id: 'fx.sampler.reverb.size', label: 'SIZE' },
    { id: 'fx.sampler.reverb.damp', label: 'DAMP' },
    { id: 'fx.sampler.reverb.mix', label: 'MIX' },
  ]));

  root.appendChild(header);

  // ---- Slot rows ----
  const grid = document.createElement('div');
  grid.className = drumStyles.grid!;
  root.appendChild(grid);

  const stepBtns: StepButton[][] = [];
  const labels: HTMLButtonElement[] = [];
  const editBtns: HTMLButtonElement[] = [];

  // Selection cursor for the per-step edit row (one cell across the grid).
  let selSlot = 0;
  let selStep = 0;
  const setSelected = (sl: number, st: number): void => {
    stepBtns[selSlot]?.[selStep]?.el.classList.remove(StepButton.selectedClass);
    selSlot = sl;
    selStep = st;
    stepBtns[sl]?.[st]?.el.classList.add(StepButton.selectedClass);
    renderSelected();
    editor.refresh();
  };

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
        alert('Unsupported or corrupt audio file.');
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
      openRecordSoundModal(engine, { slot, source: audioBufferToCaptured(buf) });
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
    const trackBtns: StepButton[] = [];
    for (let s = 0; s < SEQ_LENGTH; s++) {
      const cell = engine.patterns.sampler[slot]![s]!;
      const sb = new StepButton('', s % 4 === 0 ? 'red' : 'orange');
      sb.el.dataset.testid = `sampler-step-${slot}-${s}`;
      sb.el.classList.add(StepButton.drumCellClass);
      paintCell(sb, cell);
      sb.el.addEventListener('click', () => {
        setSelected(slot, s);
        engine.patterns.setSamplerCell(slot, s, { on: !engine.patterns.sampler[slot]![s]!.on });
      });
      cells.appendChild(sb.el);
      trackBtns.push(sb);
    }
    stepBtns.push(trackBtns);
    row.appendChild(cells);
    grid.appendChild(row);

    refreshLabel(slot);
  }

  // ---- Per-step edit row (shared component; below the grid) ----
  const editor = new StepSettingsEditor({
    testidPrefix: 'sampler',
    get: () => engine.patterns.sampler[selSlot]?.[selStep],
    set: (p) => engine.patterns.setSamplerCell(selSlot, selStep, p),
  });
  const selectedLabel = document.createElement('div');
  selectedLabel.className = editStyles.selectedLabel!;
  const renderSelected = () => {
    const name = engine.patterns.sampleNames[selSlot] ?? SAMPLER_SLOT_LABELS[selSlot] ?? `S${selSlot + 1}`;
    selectedLabel.textContent = `${name} · step ${selStep + 1}`;
  };
  editor.el.insertBefore(selectedLabel, editor.el.firstChild);
  root.appendChild(editor.el);
  setSelected(0, 0);

  // Highlight playback position — only when viewing the bank that's playing
  const highlighter = new PlayheadHighlighter(stepBtns);
  engine.sampler.onStep((idx) => {
    const match = engine.patterns.samplerEditBank === engine.arrangement.samplerPlayBank;
    highlighter.update(idx, match);
  });

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onSamplerBankChange((bank) => {
    highlighter.clear();
    for (let s = 0; s < SAMPLER_SLOT_COUNT; s++) {
      for (let i = 0; i < SEQ_LENGTH; i++) {
        const sb = stepBtns[s]?.[i];
        if (sb) paintCell(sb, bank[s]![i]!);
      }
    }
    editor.refresh();
  });

  // Live step edit updates
  engine.patterns.onSamplerChange((slot, step, cell) => {
    const sb = stepBtns[slot]?.[step];
    if (sb) paintCell(sb, cell);
    if (slot === selSlot && step === selStep) editor.refresh();
  });

  // Filename / load-state changes
  engine.patterns.onSampleMetaChange((slot) => {
    refreshLabel(slot);
    if (slot === selSlot) renderSelected();
  });

  return root;
}

function fxGroup(bus: ParamBus, title: string, onParam: string, knobs: Array<{ id: string; label: string }>): HTMLElement {
  const group = document.createElement('div');
  group.style.cssText = 'display:flex;align-items:center;gap:4px';

  const divider = document.createElement('div');
  divider.style.cssText = 'width:1px;height:28px;background:rgba(244,205,94,0.15);margin:0 4px';
  group.appendChild(divider);

  const label = document.createElement('span');
  label.textContent = title;
  label.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:0.12em;color:var(--accent-secondary);font-weight:600';
  group.appendChild(label);

  group.appendChild(new Switch(bus, `${onParam}.on`, 'on').el);

  for (const k of knobs) {
    group.appendChild(new Knob({ bus, paramId: k.id, label: k.label, size: 22 }).el);
  }

  return group;
}
