import switchStyles from '../styles/switch.module.css';
import layout from '../styles/layout.module.css';
import styles from '../styles/seq.module.css';
import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import { Switch } from '../components/switch';
import { createButton } from '../components/button';
import { StepButton } from '../components/step-button';
import { PlayheadHighlighter } from '../components/playhead-highlighter';
import { Knob } from '../components/knob';
import { BankBar } from '../components/bank-bar';
import { noteName } from '../components/keyboard';
import { SEQ_LENGTH, type SeqStep } from '../../state/patterns';

// Repaint a step cell: lit state, note label, the per-step settings viz
// (gate/velocity/prob/ratchet/tie) and a tooltip with the exact values.
function paintStep(sb: StepButton, s: SeqStep): void {
  sb.setOn(s.on);
  sb.setLabel(noteName(s.note));
  sb.setViz(s);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  sb.el.title = `${noteName(s.note)} · vel ${pct(s.velocity)} · gate ${pct(s.gate)} · prob ${pct(s.prob)}`
    + (s.ratchet > 1 ? ` · ×${s.ratchet}` : '')
    + (s.tie ? ' · tie' : '');
}

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
    testidPrefix: 'seq',
  }).el);

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
  root.appendChild(stepRow);

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
  edit.appendChild(noteCtrl);

  function bumpNote(delta: number, index = selected): void {
    const s = engine.patterns.seq[index];
    if (!s) return;
    const next = Math.max(0, Math.min(127, s.note + delta));
    engine.patterns.setSeqStep(index, { note: next });
    if (index === selected) noteDisplay.textContent = noteName(next);
  }

  // Use simple sliders for velocity/gate of the selected step
  // (avoids needing a per-step ParamBus entry)
  const velSlider = makeSlider('Velocity', 0, 1, () => engine.patterns.seq[selected]?.velocity ?? 0.8,
    (v) => engine.patterns.setSeqStep(selected, { velocity: v }));
  edit.appendChild(velSlider.el);

  const gateSlider = makeSlider('Gate', 0.05, 1, () => engine.patterns.seq[selected]?.gate ?? 0.5,
    (v) => engine.patterns.setSeqStep(selected, { gate: v }));
  edit.appendChild(gateSlider.el);

  const probSlider = makeSlider('Prob', 0, 1, () => engine.patterns.seq[selected]?.prob ?? 1,
    (v) => engine.patterns.setSeqStep(selected, { prob: v }));
  probSlider.el.dataset.testid = 'seq-prob';
  edit.appendChild(probSlider.el);

  // Ratchet — 1..4 sub-hits within the step.
  const ratchetCtrl = document.createElement('div');
  ratchetCtrl.className = styles.noteCtrl!;
  ratchetCtrl.dataset.testid = 'seq-ratchet';
  const ratchetLabel = document.createElement('div');
  ratchetLabel.className = styles.noteLabel!;
  ratchetLabel.textContent = 'Ratchet';
  ratchetCtrl.appendChild(ratchetLabel);
  const ratchetBtns: HTMLButtonElement[] = [];
  for (let n = 1; n <= 4; n++) {
    const b = document.createElement('button');
    b.className = switchStyles.root!;
    b.textContent = String(n);
    b.dataset.testid = `seq-ratchet-${n}`;
    b.title = `${n} hit${n > 1 ? 's' : ''} per step`;
    b.addEventListener('click', () => engine.patterns.setSeqStep(selected, { ratchet: n }));
    ratchetBtns.push(b);
    ratchetCtrl.appendChild(b);
  }
  const refreshRatchet = () => {
    const r = Math.max(1, Math.round(engine.patterns.seq[selected]?.ratchet ?? 1));
    ratchetBtns.forEach((b, i) => b.classList.toggle('on', i + 1 === r));
  };
  edit.appendChild(ratchetCtrl);

  // Tie — hold this step into the next (legato / slide).
  const tieBtn = createButton({
    label: 'Tie',
    led: true,
    testId: 'seq-tie',
    onClick: () => engine.patterns.setSeqStep(selected, { tie: !engine.patterns.seq[selected]?.tie }),
  });
  tieBtn.title = 'Tie — hold into the next step (legato); slides when mixer.glide > 0';
  const refreshTie = () => tieBtn.classList.toggle('on', !!engine.patterns.seq[selected]?.tie);
  edit.appendChild(tieBtn);

  root.appendChild(edit);

  const refresh = () => {
    const s = engine.patterns.seq[selected];
    if (!s) return;
    noteDisplay.textContent = noteName(s.note);
    velSlider.refresh();
    gateSlider.refresh();
    probSlider.refresh();
    refreshRatchet();
    refreshTie();
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
