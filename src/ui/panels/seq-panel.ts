import switchStyles from '../styles/switch.module.css';
import layout from '../styles/layout.module.css';
import styles from '../styles/seq.module.css';
import editStyles from '../styles/step-settings.module.css';
import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import type { PatternUndo } from '../../state/pattern-undo';
import { createUndoButton } from '../components/undo-button';
import { Switch } from '../components/switch';
import { createButton } from '../components/button';
import { StepButton } from '../components/step-button';
import { PlayheadHighlighter } from '../components/playhead-highlighter';
import { BankBar } from '../components/bank-bar';
import { buildRestOverlay } from '../components/rest-overlay';
import { noteName } from '../components/keyboard';
import { StepSettingsEditor, stepTitle } from '../components/step-settings';
import { Dropdown } from '../components/dropdown';
import { capturedToAudioBuffer } from '../../audio/recorder/audio-buffer';
import {
  BANK_LABELS,
  SAMPLER_SLOT_COUNT,
  SAMPLER_SLOT_LABELS,
  SEQ_LENGTH,
  type SeqStep,
} from '../../state/patterns';

// Repaint a step cell: lit state, note label, the per-step settings viz
// (gate/velocity/prob/ratchet/tie) and a tooltip with the exact values.
function paintStep(sb: StepButton, s: SeqStep): void {
  sb.setOn(s.on);
  sb.setLabel(noteName(s.note));
  sb.setViz(s);
  sb.el.title = `${noteName(s.note)} · ${stepTitle(s)}`;
}

export function buildSeqPanel(bus: ParamBus, engine: StudioApi, undo: PatternUndo): HTMLElement {
  const root = document.createElement('div');
  root.className = `${layout.patternPanel!} seq-panel`;

  // ---- Header ----
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'seq.on', 'seq').el);
  const bankBar = new BankBar({
    getEdit: () => engine.patterns.seqEditBank,
    setEdit: (i) => engine.patterns.setSeqEditBank(i),
    copy: (f, t) => engine.patterns.copySeqBank(f, t),
    onEditChange: (fn) => engine.patterns.onEditBankChange(fn),
    getPlay: () => engine.arrangement.seqPlayBank,
    onPlayChange: (fn) => engine.arrangement.onChange(fn),
    hasContent: (i) => engine.patterns.seqBanks[i]!.some((s) => s.on),
    onContentChange: (fn) => engine.patterns.onSeqChange(fn),
    testidPrefix: 'seq',
  });
  header.appendChild(bankBar.el);
  header.appendChild(createUndoButton(undo, 'seq'));

  // Step-record arm toggle. While armed, played notes fill steps (see below).
  let armed = false;
  const recBtn = createButton({
    label: 'Step Input',
    led: true,
    testId: 'seq-step-input',
    onClick: () => {
      armed = !armed;
      recBtn.classList.toggle('on', armed);
      stepRow.classList.toggle(styles.recording!, armed);
    },
  });
  recBtn.title = 'Step Input — play notes (keyboard / MIDI) to fill steps; the cursor auto-advances';
  header.appendChild(recBtn);

  const selectedLabel = document.createElement('div');
  selectedLabel.className = editStyles.selectedLabel!;
  header.appendChild(selectedLabel);
  root.appendChild(header);

  // ---- Step row ----
  const stepRow = document.createElement('div');
  stepRow.className = styles.stepRow!;
  const steps: StepButton[] = [];
  let selected = 0;

  const renderSelected = () => {
    const s = engine.patterns.seq[selected];
    if (!s) return;
    selectedLabel.textContent = `Step ${selected + 1}  ${noteName(s.note)}  vel ${(s.velocity * 100).toFixed(0)}%  gate ${(s.gate * 100).toFixed(0)}%`;
  };

  // Single place that moves the selection cursor and repaints the edit row.
  // Used by clicks, the wheel handler, and step-record auto-advance.
  function setSelected(i: number): void {
    selected = i;
    for (let k = 0; k < steps.length; k++) {
      steps[k]!.el.classList.toggle(StepButton.selectedClass, k === selected);
    }
    renderSelected();
    refresh();
  }

  for (let i = 0; i < SEQ_LENGTH; i++) {
    const cell = engine.patterns.seq[i]!;
    const sb = new StepButton(noteName(cell.note), 'orange');
    sb.el.dataset.testid = `seq-step-${i}`;
    paintStep(sb, cell);
    sb.el.addEventListener('click', () => {
      setSelected(i);
      // While armed, a click only moves the cursor; otherwise toggle on/off.
      if (!armed) {
        // Read the *current* edit bank's step, not the one captured at build.
        const cur = engine.patterns.seq[i];
        engine.patterns.setSeqStep(i, { on: !cur?.on });
      }
    });
    // Scroll a step to change its pitch: wheel = ±1 semitone, Shift = ±1 octave.
    sb.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      setSelected(i);
      bumpNote((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 12 : 1), i);
    }, { passive: false });
    steps.push(sb);
    stepRow.appendChild(sb.el);
  }
  // Wrap the grid so the rest overlay can cover it while the arrangement plays a
  // rest bar (arrangement-rest.md REQ-6).
  const gridWrap = document.createElement('div');
  gridWrap.style.position = 'relative';
  gridWrap.appendChild(stepRow);
  const restOverlay = buildRestOverlay(engine, 'seq', { following: () => bankBar.following });
  gridWrap.appendChild(restOverlay.el);
  bankBar.onFollowChange(() => restOverlay.refresh());
  root.appendChild(gridWrap);

  // Step record: while armed, played notes (keyboard / QWERTY / MIDI) land in the
  // selected step and the cursor advances. Audition is automatic — bus.onNote also
  // reaches the engine, so the note sounds while transport passthrough isn't
  // suppressed (i.e. the usual case of editing while stopped).
  bus.onNote((on, note) => {
    if (!armed || !on) return;
    engine.patterns.setSeqStep(selected, { on: true, note });
    setSelected((selected + 1) % SEQ_LENGTH);
  });

  // Highlight playback position — only when viewing the bank that's playing
  const highlighter = new PlayheadHighlighter([steps]);
  engine.seq.onStep((idx) => {
    const match = engine.patterns.seqEditBank === engine.arrangement.seqPlayBank;
    highlighter.update(idx, match);
    restOverlay.refresh();
  });

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onSeqBankChange((bank) => {
    highlighter.clear();
    for (let i = 0; i < SEQ_LENGTH; i++) {
      const s = bank[i]!;
      const sb = steps[i];
      if (!sb) continue;
      paintStep(sb, s);
    }
    renderSelected();
  });

  // Live step edit updates
  engine.patterns.onSeqChange((idx, step) => {
    const sb = steps[idx];
    if (!sb) return;
    paintStep(sb, step);
    if (idx === selected) renderSelected();
  });

  // ---- Edit row ---- (shared sliders/ratchet/tie + the seq-only note picker)
  const editor = new StepSettingsEditor({
    testidPrefix: 'seq',
    get: () => engine.patterns.seq[selected],
    set: (p) => engine.patterns.setSeqStep(selected, p),
  });
  const edit = editor.el;

  const noteCtrl = document.createElement('div');
  noteCtrl.className = editStyles.ctrl!;
  const noteLabel = document.createElement('div');
  noteLabel.className = editStyles.ctrlLabel!;
  noteLabel.textContent = 'Note';
  noteCtrl.appendChild(noteLabel);
  const downBtn = document.createElement('button');
  downBtn.className = switchStyles.root!;
  downBtn.textContent = '−';
  downBtn.title = 'Lower pitch — Shift+click for a full octave';
  downBtn.addEventListener('click', (e) => bumpNote(e.shiftKey ? -12 : -1));
  noteCtrl.appendChild(downBtn);
  const noteDisplay = document.createElement('div');
  noteDisplay.className = styles.noteDisplay!;
  noteDisplay.title = 'Scroll to change pitch — Shift+scroll for octaves';
  noteDisplay.addEventListener('wheel', (e) => {
    e.preventDefault();
    bumpNote((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 12 : 1));
  }, { passive: false });
  noteCtrl.appendChild(noteDisplay);
  const upBtn = document.createElement('button');
  upBtn.className = switchStyles.root!;
  upBtn.textContent = '+';
  upBtn.title = 'Raise pitch — Shift+click for a full octave';
  upBtn.addEventListener('click', (e) => bumpNote(e.shiftKey ? 12 : 1));
  noteCtrl.appendChild(upBtn);
  edit.insertBefore(noteCtrl, edit.firstChild); // note picker leads the row

  function bumpNote(delta: number, index = selected): void {
    const s = engine.patterns.seq[index];
    if (!s) return;
    const next = Math.max(0, Math.min(127, s.note + delta));
    engine.patterns.setSeqStep(index, { note: next });
    if (index === selected) noteDisplay.textContent = noteName(next);
  }

  root.appendChild(edit);

  // ---- Import into sampler ---- (render-to-sampler.md REQ-9)
  // Resample the edit bank through the live synth + FX into a bar-exact buffer
  // and drop it into a sampler slot — layering without a second synth instance.
  const importRow = document.createElement('div');
  importRow.className = styles.importRow!;
  const importLabel = document.createElement('div');
  importLabel.className = styles.importLabel!;
  importLabel.textContent = 'Import into sampler';
  importRow.appendChild(importLabel);

  const slotOptions = (): string[] =>
    Array.from({ length: SAMPLER_SLOT_COUNT }, (_, i) => {
      const name = engine.patterns.sampleNames[i] ?? null;
      const tag = SAMPLER_SLOT_LABELS[i] ?? `S${i + 1}`;
      return `${tag} — ${name ?? 'empty'}`;
    });
  const slotPicker = new Dropdown(slotOptions(), slotOptions()[0]);
  slotPicker.el.dataset.testid = 'seq-import-slot';
  const selectedSlot = (): number => {
    const i = slotOptions().indexOf(slotPicker.value);
    return i < 0 ? 0 : i;
  };
  // Keep the option labels in step with slot names without losing the pick.
  engine.patterns.onSampleMetaChange(() => {
    const keep = selectedSlot();
    const opts = slotOptions();
    slotPicker.setOptions(opts);
    slotPicker.setValue(opts[keep] ?? opts[0]!);
  });
  importRow.appendChild(slotPicker.el);

  const importStatus = document.createElement('span');
  importStatus.className = styles.importStatus!;

  const renderBtn = createButton({
    label: 'Render',
    testId: 'seq-import-render',
    onClick: () => { void doRender(); },
  });
  importRow.appendChild(renderBtn);
  importRow.appendChild(importStatus);
  root.appendChild(importRow);

  async function doRender(): Promise<void> {
    if (renderBtn.disabled) return;
    const slot = selectedSlot();
    const bank = engine.patterns.seqEditBank;
    const bpm = Math.round(bus.get('transport.bpm'));
    importStatus.textContent = '';
    try {
      const captured = await engine.bankRender.render();
      engine.sampler.setBuffer(slot, capturedToAudioBuffer(engine.ctx, captured));
      const name = `seq-${BANK_LABELS[bank] ?? bank + 1}-${bpm}bpm`;
      engine.patterns.setSampleName(slot, name);
      importStatus.textContent = `${name} → ${SAMPLER_SLOT_LABELS[slot] ?? slot + 1}`;
    } catch (err) {
      importStatus.textContent = err instanceof Error ? err.message : 'render failed';
    }
  }

  // Busy while rendering; otherwise gated on bank content + sync mode (REQ-6):
  // a slave doesn't own the clock, and estimator BPM writes would break the
  // bar-exact length.
  let rendering = false;
  const refreshImport = () => {
    const empty = !engine.patterns.seq.some((s) => s.on);
    const slaved = engine.sync.mode === 'slave';
    renderBtn.disabled = rendering || empty || slaved;
    renderBtn.textContent = rendering ? 'Rendering…' : 'Render';
    renderBtn.title = slaved
      ? 'Unavailable while slaved to MIDI clock'
      : empty
        ? 'Add steps to the bank first'
        : 'Render this bank (2 bars: tails bake into the loop) into the chosen sampler slot';
  };
  engine.bankRender.onState((r) => { rendering = r; refreshImport(); });
  engine.patterns.onSeqChange(() => refreshImport());
  engine.patterns.onSeqBankChange(() => refreshImport());
  engine.sync.onStatus(() => refreshImport());
  refreshImport();

  const refresh = () => {
    const s = engine.patterns.seq[selected];
    if (!s) return;
    noteDisplay.textContent = noteName(s.note);
    editor.refresh();
    renderSelected();
  };
  engine.patterns.onSeqChange((idx) => { if (idx === selected) refresh(); });
  refresh();

  // Initial selected highlight
  stepRow.querySelector(`.${StepButton.rootClass}`)?.classList.add(StepButton.selectedClass);

  return root;
}
