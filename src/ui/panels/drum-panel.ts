import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { StepButton } from '../components/step-button';
import { PlayheadHighlighter } from '../components/playhead-highlighter';
import { BankBar } from '../components/bank-bar';
import { fxGroup } from '../components/fx-group';
import { GrMeter } from '../components/gr-meter';
import { StepSettingsEditor, stepTitle } from '../components/step-settings';
import { DRUM_TRACK_LABELS } from '../../state/params';
import { DRUM_TRACK_COUNT, SEQ_LENGTH, type DrumCell } from '../../state/patterns';
import layout from '../styles/layout.module.css';
import styles from '../styles/drum.module.css';
import editStyles from '../styles/step-settings.module.css';

// Repaint a drum cell: lit state, the per-step settings viz and a tooltip.
function paintCell(sb: StepButton, cell: DrumCell): void {
  sb.setOn(cell.on);
  sb.setViz(cell);
  sb.el.title = stepTitle(cell);
}

export function buildDrumPanel(bus: ParamBus, engine: Engine): HTMLElement {
  const root = document.createElement('div');
  root.className = `${layout.patternPanel!} drum-panel`;
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'drum.on', 'drums').el);
  header.appendChild(new Knob({ bus, paramId: 'drum.master', label: 'MASTER' }).el);
  header.appendChild(new BankBar({
    getEdit: () => engine.patterns.drumEditBank,
    setEdit: (i) => engine.patterns.setDrumEditBank(i),
    copy: (f, t) => engine.patterns.copyDrumBank(f, t),
    onEditChange: (fn) => engine.patterns.onEditBankChange(fn),
    getPlay: () => engine.arrangement.drumPlayBank,
    onPlayChange: (fn) => engine.arrangement.onChange(fn),
    hasContent: (i) => engine.patterns.drumBanks[i]!.some((tr) => tr.some((c) => c.on)),
    onContentChange: (fn) => engine.patterns.onDrumChange(fn),
    testidPrefix: 'drum',
  }).el);
  header.appendChild(fxGroup(bus, 'PHASER', 'fx.drum.phaser', [
    { id: 'fx.drum.phaser.rate', label: 'RATE' },
    { id: 'fx.drum.phaser.depth', label: 'DEPTH' },
    { id: 'fx.drum.phaser.feedback', label: 'FB' },
    { id: 'fx.drum.phaser.mix', label: 'MIX' },
  ]));
  header.appendChild(fxGroup(bus, 'DELAY', 'fx.drum.delay', [
    { id: 'fx.drum.delay.time', label: 'TIME' },
    { id: 'fx.drum.delay.feedback', label: 'FB' },
    { id: 'fx.drum.delay.mix', label: 'MIX' },
  ]));
  const drumGr = new GrMeter('grmeter-fx.drum.comp');
  engine.drumComp.onGr((db) => drumGr.update(db));
  header.appendChild(fxGroup(bus, 'COMP', 'fx.drum.comp', [
    { id: 'fx.drum.comp.threshold', label: 'THR' },
    { id: 'fx.drum.comp.ratio', label: 'RATIO' },
    { id: 'fx.drum.comp.attack', label: 'ATK' },
    { id: 'fx.drum.comp.release', label: 'REL' },
    { id: 'fx.drum.comp.makeup', label: 'GAIN' },
  ], { trailing: drumGr.el }));
  root.appendChild(header);

  // ---- Track rows ----
  const grid = document.createElement('div');
  grid.className = styles.grid!;
  const stepBtns: StepButton[][] = [];

  // Selection cursor for the per-step edit row (one cell across the grid).
  let selTrack = 0;
  let selStep = 0;
  const setSelected = (t: number, s: number): void => {
    stepBtns[selTrack]?.[selStep]?.el.classList.remove(StepButton.selectedClass);
    selTrack = t;
    selStep = s;
    stepBtns[t]?.[s]?.el.classList.add(StepButton.selectedClass);
    renderSelected();
    editor.refresh();
  };

  for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
    const row = document.createElement('div');
    row.className = styles.row!;
    const ctrls = document.createElement('div');
    ctrls.className = styles.rowCtrls!;

    const label = document.createElement('button');
    label.className = styles.trackLabel!;
    label.dataset.testid = `drum-track-${t}`;
    label.textContent = DRUM_TRACK_LABELS[t] ?? `T${t}`;
    label.title = 'Click to audition';
    label.addEventListener('click', () => engine.drums.triggerTrack(t, 0.9));
    ctrls.appendChild(label);

    const mute = new Switch(bus, `drum.t${t}.mute`, 'mute');
    mute.el.classList.add(styles.mute!);
    ctrls.appendChild(mute.el);

    row.appendChild(ctrls);

    const cells = document.createElement('div');
    cells.className = styles.cells!;
    const trackBtns: StepButton[] = [];
    for (let s = 0; s < SEQ_LENGTH; s++) {
      const cell = engine.patterns.drum[t]![s]!;
      const sb = new StepButton('', s % 4 === 0 ? 'red' : 'orange');
      sb.el.dataset.testid = `drum-step-${t}-${s}`;
      sb.el.classList.add(StepButton.drumCellClass);
      paintCell(sb, cell);
      sb.el.addEventListener('click', () => {
        setSelected(t, s);
        engine.patterns.setDrumCell(t, s, { on: !engine.patterns.drum[t]![s]!.on });
      });
      cells.appendChild(sb.el);
      trackBtns.push(sb);
    }
    stepBtns.push(trackBtns);
    row.appendChild(cells);
    grid.appendChild(row);
  }
  root.appendChild(grid);

  // ---- Per-step edit row (shared component; below the grid) ----
  const editor = new StepSettingsEditor({
    testidPrefix: 'drum',
    get: () => engine.patterns.drum[selTrack]?.[selStep],
    set: (p) => engine.patterns.setDrumCell(selTrack, selStep, p),
  });
  const selectedLabel = document.createElement('div');
  selectedLabel.className = editStyles.selectedLabel!;
  const renderSelected = () => {
    selectedLabel.textContent = `${DRUM_TRACK_LABELS[selTrack] ?? `T${selTrack}`} · step ${selStep + 1}`;
  };
  editor.el.insertBefore(selectedLabel, editor.el.firstChild);
  root.appendChild(editor.el);
  setSelected(0, 0);

  // Highlight playback position — only when viewing the bank that's playing
  const highlighter = new PlayheadHighlighter(stepBtns);
  engine.drums.onStep((idx) => {
    const match = engine.patterns.drumEditBank === engine.arrangement.drumPlayBank;
    highlighter.update(idx, match);
  });

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onDrumBankChange((bank) => {
    highlighter.clear();
    for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
      for (let s = 0; s < SEQ_LENGTH; s++) {
        const sb = stepBtns[t]?.[s];
        if (sb) paintCell(sb, bank[t]![s]!);
      }
    }
    editor.refresh();
  });

  // Live step edit updates
  engine.patterns.onDrumChange((track, step, cell) => {
    const sb = stepBtns[track]?.[step];
    if (sb) paintCell(sb, cell);
    if (track === selTrack && step === selStep) editor.refresh();
  });

  return root;
}
