import type { ParamBus } from '../../state/params';
import type { Engine } from '../../audio/engine';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { StepButton } from '../components/step-button';
import { BankBar } from '../components/bank-bar';
import { SAMPLER_SLOT_COUNT, SAMPLER_SLOT_LABELS, SEQ_LENGTH } from '../../state/patterns';

export function buildSamplerPanel(bus: ParamBus, engine: Engine): HTMLElement {
  const root = document.createElement('div');
  root.className = 'pattern-panel drum-panel sampler-panel';

  // ---- Header ----
  const header = document.createElement('div');
  header.className = 'pattern-panel-header';
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
  }).el);
  root.appendChild(header);

  // ---- Slot rows ----
  const grid = document.createElement('div');
  grid.className = 'drum-grid';
  root.appendChild(grid);

  const stepBtns: StepButton[][] = [];
  const labels: HTMLButtonElement[] = [];

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
  };

  for (let t = 0; t < SAMPLER_SLOT_COUNT; t++) {
    const slot = t;
    const row = document.createElement('div');
    row.className = 'drum-row';

    const ctrls = document.createElement('div');
    ctrls.className = 'drum-row-ctrls';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.wav,.mp3';
    fileInput.style.display = 'none';
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
    loadBtn.className = 'switch sampler-load';
    loadBtn.textContent = 'Load';
    loadBtn.title = 'Load a WAV/MP3 file into this slot';
    loadBtn.addEventListener('click', () => fileInput.click());
    ctrls.appendChild(loadBtn);

    const label = document.createElement('button');
    label.className = 'drum-track-label sampler-name';
    label.addEventListener('click', () => engine.sampler.triggerSlot(slot, 0.9));
    labels[slot] = label;
    ctrls.appendChild(label);

    const mute = new Switch(bus, `sampler.t${slot}.mute`, 'mute');
    mute.el.classList.add('drum-mute');
    ctrls.appendChild(mute.el);

    ctrls.appendChild(fileInput);
    row.appendChild(ctrls);

    const cells = document.createElement('div');
    cells.className = 'drum-cells';
    const trackBtns: StepButton[] = [];
    for (let s = 0; s < SEQ_LENGTH; s++) {
      const cell = engine.patterns.sampler[slot]![s]!;
      const sb = new StepButton('', s % 4 === 0 ? 'red' : 'orange');
      sb.setOn(cell.on);
      sb.el.classList.add('drum-cell');
      sb.el.addEventListener('click', () => {
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

  // Highlight playback position
  engine.sampler.onStep((idx) => {
    for (const row of stepBtns) {
      for (let i = 0; i < row.length; i++) row[i]!.setPlaying(i === idx);
    }
  });

  // External pattern changes (preset/song load, bank switch)
  engine.patterns.onSamplerChange((slot, step, cell) => {
    stepBtns[slot]?.[step]?.setOn(cell.on);
  });

  // Filename / load-state changes
  engine.patterns.onSampleMetaChange((slot) => refreshLabel(slot));

  return root;
}
