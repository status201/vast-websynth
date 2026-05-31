import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { StepButton } from '../components/step-button';
import { BankBar } from '../components/bank-bar';
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
  }).el);
  header.appendChild(fxGroup(bus, 'PHASER', 'fx.drum.phaser', [
    { id: 'fx.drum.phaser.rate', label: 'RATE' },
    { id: 'fx.drum.phaser.depth', label: 'DEPTH' },
    { id: 'fx.drum.phaser.feedback', label: 'FB' },
  ]));
  header.appendChild(fxGroup(bus, 'DELAY', 'fx.drum.delay', [
    { id: 'fx.drum.delay.time', label: 'TIME' },
    { id: 'fx.drum.delay.feedback', label: 'FB' },
    { id: 'fx.drum.delay.mix', label: 'MIX' },
  ]));
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
  engine.drums.onStep((idx) => {
    const match = engine.patterns.drumEditBank === engine.arrangement.drumPlayBank;
    for (const row of stepBtns) {
      for (let i = 0; i < row.length; i++) row[i]!.setPlaying(match && i === idx);
    }
  });

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onDrumBankChange((bank) => {
    stepBtns.forEach((row) => row.forEach((s) => s.setPlaying(false)));
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
