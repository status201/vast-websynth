import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { StepButton } from '../components/step-button';
import { BankBar } from '../components/bank-bar';
import { DRUM_TRACK_LABELS } from '../../state/params';
import { DRUM_TRACK_COUNT, SEQ_LENGTH } from '../../state/patterns';

export function buildDrumPanel(bus: ParamBus, engine: Engine): HTMLElement {
  const root = document.createElement('div');
  root.className = 'pattern-panel drum-panel';

  // ---- Header ----
  const header = document.createElement('div');
  header.className = 'pattern-panel-header';
  header.appendChild(new Switch(bus, 'drum.on', 'drums').el);
  header.appendChild(new Knob({ bus, paramId: 'drum.master', label: 'MASTER' }).el);
  header.appendChild(new BankBar({
    getEdit: () => engine.patterns.drumEditBank,
    setEdit: (i) => engine.patterns.setDrumEditBank(i),
    copy: (f, t) => engine.patterns.copyDrumBank(f, t),
    onEditChange: (fn) => engine.patterns.onEditBankChange(fn),
    getPlay: () => engine.arrangement.drumPlayBank,
    onPlayChange: (fn) => engine.arrangement.onChange(fn),
  }).el);
  root.appendChild(header);

  // ---- Track rows ----
  const grid = document.createElement('div');
  grid.className = 'drum-grid';
  root.appendChild(grid);

  const stepBtns: StepButton[][] = [];

  for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
    const row = document.createElement('div');
    row.className = 'drum-row';

    const ctrls = document.createElement('div');
    ctrls.className = 'drum-row-ctrls';

    const label = document.createElement('button');
    label.className = 'drum-track-label';
    label.textContent = DRUM_TRACK_LABELS[t] ?? `T${t}`;
    label.title = 'Click to audition';
    label.addEventListener('click', () => engine.drums.triggerTrack(t, 0.9));
    ctrls.appendChild(label);

    const mute = new Switch(bus, `drum.t${t}.mute`, 'mute');
    mute.el.classList.add('drum-mute');
    ctrls.appendChild(mute.el);

    row.appendChild(ctrls);

    const cells = document.createElement('div');
    cells.className = 'drum-cells';
    const trackBtns: StepButton[] = [];
    for (let s = 0; s < SEQ_LENGTH; s++) {
      const cell = engine.patterns.drum[t]![s]!;
      const sb = new StepButton('', s % 4 === 0 ? 'red' : 'orange');
      sb.setOn(cell.on);
      sb.el.classList.add('drum-cell');
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

  // Highlight playback position
  engine.drums.onStep((idx) => {
    for (const row of stepBtns) {
      for (let i = 0; i < row.length; i++) row[i]!.setPlaying(i === idx);
    }
  });

  // External pattern changes
  engine.patterns.onDrumChange((track, step, cell) => {
    stepBtns[track]?.[step]?.setOn(cell.on);
  });

  return root;
}
