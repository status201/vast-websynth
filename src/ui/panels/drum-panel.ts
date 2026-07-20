import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import type { PatternUndo } from '../../state/pattern-undo';
import { createUndoButton } from '../components/undo-button';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { Dropdown } from '../components/dropdown';
import { createButton } from '../components/button';
import { StepButton } from '../components/step-button';
import { bankBarFor, wrapGridWithRestOverlay, wirePlayhead, GridCursor } from './step-panel-scaffold';
import { fxGroup } from '../components/fx-group';
import { GrMeter } from '../components/gr-meter';
import { StepSettingsEditor, paintTriggerCell } from '../components/step-settings';
import { DRUM_KITS, applyKit, randomizeKit } from '../../audio/drums/drum-kits';
import { ParamDropdown } from '../components/param-dropdown';
import { DRUM_TRACK_LABELS, DRUM_MODEL_LABELS } from '../../state/params';
import { DRUM_TRACK_COUNT, SEQ_LENGTH } from '../../state/patterns';
import layout from '../styles/layout.module.css';
import styles from '../styles/drum.module.css';
import editStyles from '../styles/step-settings.module.css';

export function buildDrumPanel(bus: ParamBus, engine: StudioApi, undo: PatternUndo): HTMLElement {
  const root = document.createElement('div');
  root.className = `${layout.patternPanel!} drum-panel`;
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'drum.on', 'drums').el);
  header.appendChild(new Knob({ bus, paramId: 'drum.master', label: 'MASTER' }).el);
  const bankBar = bankBarFor(engine, 'drum');
  header.appendChild(bankBar.el);
  header.appendChild(createUndoButton(undo, 'drum'));

  // FX groups mirror the drum bus chain order: comp → phaser → delay → reverb.
  // One cluster so the header breaks between machine controls and FX rather
  // than mid-cluster (responsive-machine-header.md).
  const drumGr = new GrMeter('grmeter-fx.drum.comp');
  engine.drumComp.onGr((db) => drumGr.update(db));
  const fx = document.createElement('div');
  fx.className = layout.fxCluster!;
  fx.appendChild(fxGroup(bus, 'COMP', 'fx.drum.comp', [
    { id: 'fx.drum.comp.threshold', label: 'THR' },
    { id: 'fx.drum.comp.ratio', label: 'RATIO' },
    { id: 'fx.drum.comp.attack', label: 'ATK' },
    { id: 'fx.drum.comp.release', label: 'REL' },
    { id: 'fx.drum.comp.makeup', label: 'GAIN' },
  ], { trailing: drumGr.el }));
  fx.appendChild(fxGroup(bus, 'PHASER', 'fx.drum.phaser', [
    { id: 'fx.drum.phaser.rate', label: 'RATE' },
    { id: 'fx.drum.phaser.depth', label: 'DEPTH' },
    { id: 'fx.drum.phaser.feedback', label: 'FB' },
    { id: 'fx.drum.phaser.mix', label: 'MIX' },
  ]));
  fx.appendChild(fxGroup(bus, 'DELAY', 'fx.drum.delay', [
    { id: 'fx.drum.delay.time', label: 'TIME' },
    { id: 'fx.drum.delay.feedback', label: 'FB' },
    { id: 'fx.drum.delay.mix', label: 'MIX' },
  ]));
  fx.appendChild(fxGroup(bus, 'REVERB', 'fx.drum.reverb', [
    { id: 'fx.drum.reverb.size', label: 'SIZE' },
    { id: 'fx.drum.reverb.damp', label: 'DAMP' },
    { id: 'fx.drum.reverb.mix', label: 'MIX' },
  ]));
  header.appendChild(fx);
  root.appendChild(header);

  // ---- Track rows ----
  const grid = document.createElement('div');
  grid.className = styles.grid!;
  const stepBtns: StepButton[][] = [];
  const trackLabels: HTMLButtonElement[] = [];

  // A row's display name follows its selected voice model (drum-machine.md
  // REQ-11); DRUM_TRACK_LABELS stays the canonical slot naming.
  const modelName = (t: number): string =>
    DRUM_MODEL_LABELS[Math.round(bus.get(`drum.t${t}.model`))] ?? DRUM_TRACK_LABELS[t] ?? `T${t}`;

  // Selection cursor for the per-step edit row (one cell across the grid).
  const cursor = new GridCursor(stepBtns, () => {
    renderSelected();
    renderTuning();
    editor.refresh();
  });
  const setSelected = (t: number, s: number): void => cursor.set(t, s);

  for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
    const row = document.createElement('div');
    row.className = styles.row!;
    const ctrls = document.createElement('div');
    ctrls.className = styles.rowCtrls!;

    const label = document.createElement('button');
    label.className = styles.trackLabel!;
    label.dataset.testid = `drum-track-${t}`;
    label.textContent = DRUM_TRACK_LABELS[t] ?? `T${t}`;
    label.title = 'Click to audition + edit its sound';
    label.addEventListener('click', () => {
      setSelected(t, cursor.selCol);
      engine.drums.triggerTrack(t, 0.9);
    });
    ctrls.appendChild(label);
    trackLabels.push(label);

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
      paintTriggerCell(sb, cell);
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
  const { el: gridWrap, restOverlay } = wrapGridWithRestOverlay(engine, 'drum', bankBar, grid);
  root.appendChild(gridWrap);

  // ---- Selected-drum tuning strip (sound design for the selected track) ----
  // Mirrors the per-step editor: one shared row driven by the selection cursor.
  // Knobs bind their paramId at construction, so the row is rebuilt on selection.
  const TUNING_PARAMS: { suffix: string; label: string }[] = [
    { suffix: 'tune', label: 'TUNE' },
    { suffix: 'decay', label: 'DECAY' },
    { suffix: 'tone', label: 'TONE' },
    { suffix: 'drive', label: 'DRIVE' },
    { suffix: 'pan', label: 'PAN' },
    { suffix: 'vol', label: 'VOL' },
  ];
  const tuning = document.createElement('div');
  tuning.className = styles.tuning!;
  const tuningLabel = document.createElement('div');
  tuningLabel.className = editStyles.selectedLabel!;
  const tuningKnobs = document.createElement('div');
  tuningKnobs.className = styles.tuningKnobs!;
  let tuningCells: Knob[] = [];
  let tuningTrack = -1;
  let modelDd: ParamDropdown | null = null;
  const renderTuning = (): void => {
    // The knobs bind per-track paramIds, so the strip only needs rebuilding when
    // the selected track changes — not on every step click (drum-machine.md REQ-10).
    if (cursor.selRow === tuningTrack) return;
    tuningTrack = cursor.selRow;
    for (const k of tuningCells) k.destroy();
    tuningCells = [];
    modelDd?.destroy();
    tuningKnobs.innerHTML = '';
    tuningLabel.textContent = `${modelName(cursor.selRow)} — sound`;
    // Voice model picker leads the strip (drum-machine.md REQ-11).
    modelDd = new ParamDropdown(bus, `drum.t${cursor.selRow}.model`, DRUM_MODEL_LABELS);
    modelDd.el.dataset.testid = 'drum-model';
    tuningKnobs.appendChild(modelDd.el);
    for (const { suffix, label } of TUNING_PARAMS) {
      const knob = new Knob({ bus, paramId: `drum.t${cursor.selRow}.${suffix}`, label, size: 34 });
      tuningCells.push(knob);
      tuningKnobs.appendChild(knob.el);
    }
  };
  const tuningReset = createButton({
    label: 'Reset',
    testId: 'drum-reset',
    onClick: () => {
      // Reset each tuning knob to the same baseline a double-tap uses (loaded
      // preset/song value, else default; see param-reset-baseline.md).
      for (const { suffix } of TUNING_PARAMS) {
        bus.reset(`drum.t${cursor.selRow}.${suffix}`);
      }
    },
  });
  // Kit picker + randomize lead the sound-design row (kept out of the header so
  // it doesn't widen it; see drum-kits.ts). These apply across all tracks.
  const kitLabel = document.createElement('span');
  kitLabel.className = styles.kitLabel!;
  kitLabel.textContent = 'KIT';
  const kitDd = new Dropdown(Object.keys(DRUM_KITS), 'Default');
  kitDd.el.dataset.testid = 'drum-kit';
  kitDd.onChange((name) => applyKit(bus, name));
  const kitRandom = createButton({
    label: '🎲 Random',
    testId: 'drum-randomize',
    onClick: () => randomizeKit(bus),
  });

  tuning.appendChild(kitLabel);
  tuning.appendChild(kitDd.el);
  tuning.appendChild(kitRandom);
  tuning.appendChild(tuningLabel);
  tuning.appendChild(tuningKnobs);
  tuning.appendChild(tuningReset);
  root.appendChild(tuning);

  // ---- Per-step edit row (shared component; below the grid) ----
  const editor = new StepSettingsEditor({
    testidPrefix: 'drum',
    get: () => engine.patterns.drum[cursor.selRow]?.[cursor.selCol],
    set: (p) => engine.patterns.setDrumCell(cursor.selRow, cursor.selCol, p),
  });
  const selectedLabel = document.createElement('div');
  selectedLabel.className = editStyles.selectedLabel!;
  const renderSelected = () => {
    selectedLabel.textContent = `${modelName(cursor.selRow)} · step ${cursor.selCol + 1}`;
  };
  editor.el.insertBefore(selectedLabel, editor.el.firstChild);
  root.appendChild(editor.el);
  setSelected(0, 0);

  // Row + strip labels follow the voice model live (kit switches, song loads).
  for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
    const track = t;
    bus.subscribe(`drum.t${t}.model`, () => {
      const name = modelName(track);
      const l = trackLabels[track];
      if (l) l.textContent = name;
      if (track === cursor.selRow) {
        tuningLabel.textContent = `${name} — sound`;
        renderSelected();
      }
    });
  }

  const highlighter = wirePlayhead(engine, 'drum', stepBtns, restOverlay);

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onDrumBankChange((bank) => {
    highlighter.clear();
    for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
      for (let s = 0; s < SEQ_LENGTH; s++) {
        const sb = stepBtns[t]?.[s];
        if (sb) paintTriggerCell(sb, bank[t]![s]!);
      }
    }
    editor.refresh();
  });

  // Live step edit updates
  engine.patterns.onDrumChange((track, step, cell) => {
    const sb = stepBtns[track]?.[step];
    if (sb) paintTriggerCell(sb, cell);
    if (track === cursor.selRow && step === cursor.selCol) editor.refresh();
  });

  return root;
}
