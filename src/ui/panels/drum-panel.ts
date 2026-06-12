import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { StepButton } from '../components/step-button';
import { PlayheadHighlighter } from '../components/playhead-highlighter';
import { BankBar } from '../components/bank-bar';
import { fxGroup } from '../components/fx-group';
import { GrMeter } from '../components/gr-meter';
import { DRUM_TRACK_LABELS } from '../../state/params';
import { DRUM_TRACK_COUNT, SEQ_LENGTH } from '../../state/patterns';
import layout from '../styles/layout.module.css';
import styles from '../styles/drum.module.css';

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
      sb.setOn(cell.on);
      sb.el.classList.add(StepButton.drumCellClass);
      sb.el.addEventListener('click', () => {
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
        stepBtns[t]?.[s]?.setOn(bank[t]![s]!.on);
      }
    }
  });

  // Live step edit updates
  engine.patterns.onDrumChange((track, step, cell) => {
    stepBtns[track]?.[step]?.setOn(cell.on);
  });

  return root;
}
