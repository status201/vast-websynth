import switchStyles from '../styles/switch.module.css';
import layout from '../styles/layout.module.css';
import styles from '../styles/seq.module.css';
import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import { Switch } from '../components/switch';
import { StepButton } from '../components/step-button';
import { PlayheadHighlighter } from '../components/playhead-highlighter';
import { Knob } from '../components/knob';
import { BankBar } from '../components/bank-bar';
import { noteName } from '../components/keyboard';
import { SEQ_LENGTH } from '../../state/patterns';

export function buildSeqPanel(bus: ParamBus, engine: Engine): HTMLElement {
  const root = document.createElement('div');
  root.className = `${layout.patternPanel!} seq-panel`;

  // ---- Header ----
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'seq.on', 'seq').el);
  header.appendChild(new BankBar({
    getEdit: () => engine.patterns.seqEditBank,
    setEdit: (i) => engine.patterns.setSeqEditBank(i),
    copy: (f, t) => engine.patterns.copySeqBank(f, t),
    onEditChange: (fn) => engine.patterns.onEditBankChange(fn),
    getPlay: () => engine.arrangement.seqPlayBank,
    onPlayChange: (fn) => engine.arrangement.onChange(fn),
    hasContent: (i) => engine.patterns.seqBanks[i]!.some((s) => s.on),
    onContentChange: (fn) => engine.patterns.onSeqChange(fn),
  }).el);
  const selectedLabel = document.createElement('div');
  selectedLabel.className = styles.selectedLabel!;
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

  for (let i = 0; i < SEQ_LENGTH; i++) {
    const cell = engine.patterns.seq[i]!;
    const sb = new StepButton(noteName(cell.note), 'orange');
    sb.el.dataset.testid = `seq-step-${i}`;
    sb.setOn(cell.on);
    sb.el.addEventListener('click', () => {
      selected = i;
      // Read the *current* edit bank's step, not the one captured at build.
      const cur = engine.patterns.seq[i];
      engine.patterns.setSeqStep(i, { on: !cur?.on });
      renderSelected();
      stepRow.querySelectorAll(`.${StepButton.rootClass}`).forEach((el, idx) => {
        el.classList.toggle(StepButton.selectedClass, idx === selected);
      });
    });
    steps.push(sb);
    stepRow.appendChild(sb.el);
  }
  root.appendChild(stepRow);

  // Highlight playback position — only when viewing the bank that's playing
  const highlighter = new PlayheadHighlighter([steps]);
  engine.seq.onStep((idx) => {
    const match = engine.patterns.seqEditBank === engine.arrangement.seqPlayBank;
    highlighter.update(idx, match);
  });

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onSeqBankChange((bank) => {
    highlighter.clear();
    for (let i = 0; i < SEQ_LENGTH; i++) {
      const s = bank[i]!;
      const sb = steps[i];
      if (!sb) continue;
      sb.setOn(s.on);
      sb.setLabel(noteName(s.note));
    }
    renderSelected();
  });

  // Live step edit updates
  engine.patterns.onSeqChange((idx, step) => {
    const sb = steps[idx];
    if (!sb) return;
    sb.setOn(step.on);
    sb.setLabel(noteName(step.note));
    if (idx === selected) renderSelected();
  });

  // ---- Edit row ----
  const edit = document.createElement('div');
  edit.className = styles.edit!;

  const noteCtrl = document.createElement('div');
  noteCtrl.className = styles.noteCtrl!;
  const noteLabel = document.createElement('div');
  noteLabel.className = styles.noteLabel!;
  noteLabel.textContent = 'Note';
  noteCtrl.appendChild(noteLabel);
  const downBtn = document.createElement('button');
  downBtn.className = switchStyles.root!;
  downBtn.textContent = '−';
  downBtn.addEventListener('click', () => bumpNote(-1));
  noteCtrl.appendChild(downBtn);
  const noteDisplay = document.createElement('div');
  noteDisplay.className = styles.noteDisplay!;
  noteCtrl.appendChild(noteDisplay);
  const upBtn = document.createElement('button');
  upBtn.className = switchStyles.root!;
  upBtn.textContent = '+';
  upBtn.addEventListener('click', () => bumpNote(1));
  noteCtrl.appendChild(upBtn);
  edit.appendChild(noteCtrl);

  function bumpNote(delta: number): void {
    const s = engine.patterns.seq[selected];
    if (!s) return;
    const next = Math.max(0, Math.min(127, s.note + delta));
    engine.patterns.setSeqStep(selected, { note: next });
    noteDisplay.textContent = noteName(next);
  }

  // Use simple sliders for velocity/gate of the selected step
  // (avoids needing a per-step ParamBus entry)
  const velSlider = makeSlider('Velocity', 0, 1, () => engine.patterns.seq[selected]?.velocity ?? 0.8,
    (v) => engine.patterns.setSeqStep(selected, { velocity: v }));
  edit.appendChild(velSlider.el);

  const gateSlider = makeSlider('Gate', 0.05, 1, () => engine.patterns.seq[selected]?.gate ?? 0.5,
    (v) => engine.patterns.setSeqStep(selected, { gate: v }));
  edit.appendChild(gateSlider.el);

  root.appendChild(edit);

  const refresh = () => {
    const s = engine.patterns.seq[selected];
    if (!s) return;
    noteDisplay.textContent = noteName(s.note);
    velSlider.refresh();
    gateSlider.refresh();
    renderSelected();
  };
  engine.patterns.onSeqChange((idx) => { if (idx === selected) refresh(); });
  refresh();

  // Initial selected highlight
  stepRow.querySelector(`.${StepButton.rootClass}`)?.classList.add(StepButton.selectedClass);

  // Avoid unused-variable warning on Knob (kept import for potential future use)
  void Knob;

  return root;
}

function makeSlider(label: string, min: number, max: number, get: () => number, set: (v: number) => void): { el: HTMLElement; refresh(): void } {
  const root = document.createElement('div');
  root.className = styles.slider!;
  const l = document.createElement('div');
  l.className = styles.sliderLabel!;
  l.textContent = label;
  root.appendChild(l);

  const track = document.createElement('div');
  track.className = styles.sliderTrack!;
  const fill = document.createElement('div');
  fill.className = styles.sliderFill!;
  track.appendChild(fill);
  root.appendChild(track);

  const valLabel = document.createElement('div');
  valLabel.className = styles.sliderValue!;
  root.appendChild(valLabel);

  const refresh = () => {
    const v = get();
    const n = (v - min) / (max - min);
    fill.style.width = `${n * 100}%`;
    valLabel.textContent = `${Math.round(n * 100)}%`;
  };

  let dragging = false;
  const handle = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const n = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    set(min + n * (max - min));
    refresh();
  };
  track.addEventListener('pointerdown', (e) => {
    dragging = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    handle(e.clientX);
  });
  window.addEventListener('pointermove', (e) => { if (dragging) handle(e.clientX); });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointercancel', () => { dragging = false; });

  return { el: root, refresh };
}
