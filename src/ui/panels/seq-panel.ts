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
import {
  bankBarFor, wrapGridWithRestOverlay, wirePlayhead, clearMenuFor, GridCursor, VisibilityGate,
  type MachinePanel,
} from './step-panel-scaffold';
import { attachGridGestures } from '../components/grid-gestures';
import { noteName } from '../components/keyboard';
import { StepSettingsEditor, stepTitle } from '../components/step-settings';
import { Dropdown } from '../components/dropdown';
import { capturedToAudioBuffer } from '../../audio/recorder/audio-buffer';
import {
  BANK_LABELS,
  SAMPLER_SLOT_COUNT,
  SAMPLER_SLOT_LABELS,
  SEQ_LENGTH,
  SEQ_TRACK_COUNT,
  SEQ_TRACK_LABELS,
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

export interface SeqPanel extends MachinePanel {
  /**
   * Turn Step Input off from outside — `app.ts` calls this the moment the panel
   * stops being on screen (sequencer.md REQ-5), so the arm can never outlive
   * the grid it writes to.
   */
  disarmStepInput(): void;
}

export function buildSeqPanel(bus: ParamBus, engine: StudioApi, undo: PatternUndo): SeqPanel {
  const root = document.createElement('div');
  root.className = `${layout.patternPanel!} seq-panel`;

  // ---- Header ----
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'seq.on', 'seq').el);
  const bankBar = bankBarFor(engine, 'seq');
  header.appendChild(bankBar.el);
  header.appendChild(createUndoButton(undo, 'seq'));
  header.appendChild(clearMenuFor(engine, 'seq', undo, () => [{
    label: `track ${SEQ_TRACK_LABELS[cursor.selRow] ?? cursor.selRow + 1}`,
    clear: () => engine.patterns.clearSeqTrack(cursor.selRow),
  }]));

  // Step-record arm toggle. While armed, played notes fill steps (see below).
  let armed = false;
  const recBtn = createButton({
    label: 'Step Input',
    led: true,
    testId: 'seq-step-input',
    onClick: () => setArmed(!armed),
  });
  recBtn.title = 'Step Input — play notes (keyboard / MIDI) to fill steps; the cursor '
    + 'auto-advances. Records only while this tab is open, into the bank on screen';
  header.appendChild(recBtn);

  // The ONE writer of `armed` and its two visual affordances (sequencer.md
  // REQ-7). Arming also drops Bank Follow so the arrangement can't swap the edit
  // bank mid-take and spray the notes across banks (REQ-6) — the same
  // editing-intent rule a manual bank click already applies. Disarming leaves
  // Follow off for the user to re-enable.
  function setArmed(on: boolean): void {
    if (armed === on) return;
    armed = on;
    recBtn.classList.toggle('on', armed);
    for (const el of trackNotes) el.classList.toggle(styles.recording!, armed);
    if (armed && bankBar.following) bankBar.setFollowing(false);
  }

  // A whole-store overwrite (song / demo / import / New / session-undo) must not
  // leave a recorder armed over someone else's song (REQ-5).
  engine.patterns.onBulkRestore(() => setArmed(false));

  const selectedLabel = document.createElement('div');
  selectedLabel.className = editStyles.selectedLabel!;
  header.appendChild(selectedLabel);
  root.appendChild(header);

  const renderSelected = (): void => {
    const s = engine.patterns.seqTrack(cursor.selRow)?.[cursor.selCol];
    if (!s) return;
    selectedLabel.textContent =
      `Track ${SEQ_TRACK_LABELS[cursor.selRow] ?? cursor.selRow + 1}  ·  Step ${cursor.selCol + 1}  ${noteName(s.note)}`
      + `  vel ${(s.velocity * 100).toFixed(0)}%  gate ${(s.gate * 100).toFixed(0)}%`;
  };

  // ---- Track rows (sequencer.md REQ-8/REQ-11) ----
  // Four independent tracks. Track 1 is the pre-v3 sequencer and never folds;
  // 2-4 fold, and start folded when empty so a fresh session still shows one
  // row while a loaded four-track song shows everything it uses.
  /** Re-run on every bank change / song load: reveal a track that has content
   *  but no explicit user preference (REQ-11). */
  const trackAutoReveal: (() => void)[] = [];

  const grid = document.createElement('div');
  grid.className = styles.trackGrid!;
  const stepBtns: StepButton[][] = [];
  const trackRows: HTMLElement[] = [];
  const trackBodies: HTMLElement[] = [];
  const trackNotes: HTMLElement[] = [];

  const collapseKey = (t: number): string => `websynth.ui.collapsed.seqtrack.${t}`;
  const trackHasSteps = (t: number): boolean =>
    engine.patterns.seqTrack(t)?.some((s) => s.on) ?? false;

  const cursor = new GridCursor(stepBtns, () => {
    renderSelected();
    editor.refresh();
    refresh();
  });
  const setSelected = (t: number, i: number): void => cursor.set(t, i);

  for (let t = 0; t < SEQ_TRACK_COUNT; t++) {
    const track = t;
    const row = document.createElement('div');
    row.className = styles.trackRow!;
    row.dataset.testid = `seq-track-${t}`;

    const ctrls = document.createElement('div');
    ctrls.className = styles.trackCtrls!;

    // Track 1 has nothing to fold; the others get a chevron that is also the
    // row's label, so the whole header is one target.
    const foldBtn = document.createElement('button');
    foldBtn.type = 'button';
    foldBtn.className = styles.trackFold!;
    foldBtn.dataset.testid = `seq-track-fold-${t}`;
    ctrls.appendChild(foldBtn);

    const mute = new Switch(bus, `seq.t${t}.mute`, 'mute');
    mute.el.classList.add(styles.trackMute!);
    ctrls.appendChild(mute.el);
    row.appendChild(ctrls);

    const body = document.createElement('div');
    body.className = styles.trackBody!;
    const stepRowEl = document.createElement('div');
    stepRowEl.className = styles.stepRow!;
    const btns: StepButton[] = [];
    for (let i = 0; i < SEQ_LENGTH; i++) {
      const index = i;
      const cell = engine.patterns.seqTrack(track)![i]!;
      const sb = new StepButton(noteName(cell.note), 'orange');
      // Track 1 keeps the original testid so every existing spec still selects
      // it; the other tracks are namespaced.
      sb.el.dataset.testid = track === 0 ? `seq-step-${i}` : `seq-step-${track}-${i}`;
      paintStep(sb, cell);
      sb.el.addEventListener('wheel', (e) => {
        e.preventDefault();
        setSelected(track, index);
        bumpNote((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 12 : 1), track, index);
      }, { passive: false });
      btns.push(sb);
      stepRowEl.appendChild(sb.el);
    }
    stepBtns.push(btns);
    body.appendChild(stepRowEl);
    row.appendChild(body);
    grid.appendChild(row);
    trackRows.push(row);
    trackBodies.push(body);
    trackNotes.push(stepRowEl);

    const setFolded = (folded: boolean, persist: boolean): void => {
      row.classList.toggle(styles.folded!, folded);
      foldBtn.textContent = `${folded ? '▸' : '▾'} ${SEQ_TRACK_LABELS[track] ?? track + 1}`;
      foldBtn.title = folded ? 'Show this track' : 'Hide this track';
      if (persist) localStorage.setItem(collapseKey(track), folded ? '1' : '0');
    };
    if (track === 0) {
      foldBtn.textContent = `▾ ${SEQ_TRACK_LABELS[0]}`;
      foldBtn.disabled = true;
      foldBtn.title = 'Track 1 is always shown';
    } else {
      const stored = localStorage.getItem(collapseKey(track));
      setFolded(stored !== null ? stored === '1' : !trackHasSteps(track), false);
      foldBtn.addEventListener('click', () => {
        setFolded(!row.classList.contains(styles.folded!), true);
      });
      // A loaded song that uses this track must never arrive hidden (REQ-11).
      trackAutoReveal.push(() => {
        if (localStorage.getItem(collapseKey(track)) === null && trackHasSteps(track)) {
          setFolded(false, false);
        }
      });
    }
  }

  // The shared gesture model (step-grid-editing.md): tap toggles, drag paints,
  // long-press / right-click selects without toggling. While Step Input is
  // armed a press only moves the cursor — the notes come from the keyboard, so
  // a toggle there would fight the take (sequencer.md REQ-5).
  attachGridGestures({
    cells: stepBtns.map((row) => row.map((sb) => sb.el)),
    isOn: (t, i) => engine.patterns.seqTrack(t)?.[i]?.on ?? false,
    onToggle: (t, i, on) => { if (!armed) engine.patterns.setSeqStep(t, i, { on }); },
    onSelect: setSelected,
    heldClass: StepButton.heldClass,
  });

  const { el: gridWrap, restOverlay } = wrapGridWithRestOverlay(engine, 'seq', bankBar, grid);
  root.appendChild(gridWrap);

  // Step record: while armed, played notes (keyboard / QWERTY / MIDI) land in the
  // selected step of the FOCUSED track (REQ-12) and the cursor advances.
  // Audition is automatic — bus.onNote also reaches the engine, so the note
  // sounds while transport passthrough isn't suppressed.
  //
  // `bus.onNote` is the *global* note funnel and cannot tell a note meant for this
  // grid from one played anywhere else, so `armed` carries the whole gate — and
  // REQ-5 keeps it true only while this panel is on screen. No visibility check
  // belongs here: one source of truth, checked once.
  bus.onNote((on, note) => {
    if (!armed || !on) return;
    engine.patterns.setSeqStep(cursor.selRow, cursor.selCol, { on: true, note });
    setSelected(cursor.selRow, (cursor.selCol + 1) % SEQ_LENGTH);
  });

  const gate = new VisibilityGate();
  const highlighter = wirePlayhead(engine, 'seq', stepBtns, restOverlay, gate);

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onSeqBankChange((bank) => {
    highlighter.clear();
    for (let t = 0; t < SEQ_TRACK_COUNT; t++) {
      for (let i = 0; i < SEQ_LENGTH; i++) {
        const sb = stepBtns[t]?.[i];
        if (sb) paintStep(sb, bank[t]![i]!);
      }
    }
    // A song that uses tracks 2-4 must not arrive with them folded away.
    for (const reveal of trackAutoReveal) reveal();
    renderSelected();
  });

  // Live step edit updates
  engine.patterns.onSeqChange((track, idx, step) => {
    const sb = stepBtns[track]?.[idx];
    if (sb) paintStep(sb, step);
    if (track === cursor.selRow && idx === cursor.selCol) renderSelected();
  });

  // ---- Edit row ---- (shared sliders/ratchet/tie + the seq-only note picker)
  const editor = new StepSettingsEditor({
    testidPrefix: 'seq',
    get: () => engine.patterns.seqTrack(cursor.selRow)?.[cursor.selCol],
    set: (p) => engine.patterns.setSeqStep(cursor.selRow, cursor.selCol, p),
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

  function bumpNote(delta: number, track = cursor.selRow, index = cursor.selCol): void {
    const s = engine.patterns.seqTrack(track)?.[index];
    if (!s) return;
    const next = Math.max(0, Math.min(127, s.note + delta));
    engine.patterns.setSeqStep(track, index, { note: next });
    if (track === cursor.selRow && index === cursor.selCol) noteDisplay.textContent = noteName(next);
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
    const empty = !engine.patterns.seq.some((track) => track.some((s) => s.on));
    const slaved = engine.sync.activeMode === 'slave';
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
    const s = engine.patterns.seqTrack(cursor.selRow)?.[cursor.selCol];
    if (!s) return;
    noteDisplay.textContent = noteName(s.note);
    editor.refresh();
    renderSelected();
  };
  engine.patterns.onSeqChange((track, idx) => {
    if (track === cursor.selRow && idx === cursor.selCol) refresh();
  });

  // Tracks 2-4 only sound in poly voicing (REQ-9): dim them and say why, rather
  // than letting four tracks fight over one mono voice.
  bus.subscribe('voicing.mode', (v) => {
    const poly = v >= 0.5;
    for (let t = 1; t < trackRows.length; t++) {
      trackRows[t]!.classList.toggle(styles.monoGated!, !poly);
      trackRows[t]!.title = poly ? '' : 'mono voicing — switch to POLY to hear this track';
    }
  });

  setSelected(0, 0);

  return {
    el: root,
    gate,
    disarmStepInput: () => setArmed(false),
    clearSelectedStep: () => engine.patterns.setSeqStep(cursor.selRow, cursor.selCol, { on: false }),
  };
}
