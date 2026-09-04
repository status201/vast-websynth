import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import type { PatternUndo } from '../../state/pattern-undo';
import type { UiBridge } from '../ui-bridge';
import { createUndoButton } from '../components/undo-button';
import { Switch } from '../components/switch';
import { Knob } from '../components/knob';
import { createButton } from '../components/button';
import { ParamDropdown } from '../components/param-dropdown';
import { fxGroup } from '../components/fx-group';
import { StepButton } from '../components/step-button';
import {
  bankBarFor, wrapGridWithRestOverlay, wirePlayhead, playheadRulerFor, laneControlsFor, laneMeterControlsFor, GridCursor, clearMenuFor,
  samplerSlotClearRow, VisibilityGate, type MachinePanel,
} from './step-panel-scaffold';
import { attachGridGestures } from '../components/grid-gestures';
import type { RecordSoundOptions } from '../components/record-sound-modal';
import { alertDialog } from '../components/dialog';
import { buildFailureReportFor } from '../failure-report';
import { showLazyLoadFailure } from '../components/lazy-load-toast';
import { StepSettingsEditor, paintTriggerCell } from '../components/step-settings';
import { audioBufferToCaptured, capturedToAudioBuffer } from '../../audio/recorder/audio-buffer';
import { showToast } from '../components/toast';
import { MIN_STRETCH_RATIO, MAX_STRETCH_RATIO } from '../../state/limits';
import { SAMPLER_SLOT_COUNT, SAMPLER_SLOT_LABELS } from '../../state/patterns';
import { ALL_CELLS, bindLaneGrid } from '../lane-grid';
import layout from '../styles/layout.module.css';
import drumStyles from '../styles/drum.module.css';
import samplerStyles from '../styles/sampler.module.css';
import editStyles from '../styles/step-settings.module.css';
import { UI_ICONS } from '../components/ui-icons';

/**
 * The recorder/editor is ~19 kB of modal that a player reaching for the sampler
 * may never open, so it loads on the click that opens it
 * (runtime-performance.md REQ-1). Both call sites go through here.
 */
async function openRecordSoundModal(engine: StudioApi, opts?: RecordSoundOptions): Promise<void> {
  let m: typeof import('../components/record-sound-modal');
  try {
    m = await import('../components/record-sound-modal');
  } catch {
    // A missing chunk is reported with a retry rather than swallowed
    // (lazy-load-failure.md). The retry carries `opts`, so the "render into
    // this slot" door reopens on the same slot the click named.
    showLazyLoadFailure('the sound recorder', () => void openRecordSoundModal(engine, opts));
    return;
  }
  m.openRecordSoundModal(engine, opts);
}

/**
 * Width of a slot row's control cluster — Load, name, ✎, FIT, mute.
 *
 * Wider than the drum panel's 130px because a sampler row carries a filename, and
 * wider again since the FIT button joined it (time-stretch.md REQ-11): at 210px
 * the name collapsed to about four characters, which is not a label.
 *
 * **The ruler row uses this too.** It used to take the drum panel's bare 130px
 * while the slot rows overrode to 210px, so the playhead ticks sat 80px left of
 * the steps they mark — the one thing `playheadRulerFor` asks the panel to get
 * right ("reusing each panel's real grid class is what keeps the ticks aligned
 * with the steps beneath them", transport-position.md REQ-9). One constant, both
 * rows, so they cannot drift apart again.
 */
const SLOT_CTRLS_WIDTH = '240px';

export function buildSamplerPanel(
  bus: ParamBus,
  engine: StudioApi,
  undo: PatternUndo,
  bridge: UiBridge,
): MachinePanel {
  const root = document.createElement('div');
  root.className = layout.patternPanel!;

  // ---- Header ----
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'sampler.on', 'sampler').el);
  // Chain / Mute / Solo, right after the machine switch — the same three
  // controls the Song tab's lane card carries (machine-status.md REQ-9).
  header.appendChild(laneControlsFor(bus, engine, 'sampler', bridge).el);
  header.appendChild(laneMeterControlsFor(bus, 'sampler').el);
  header.appendChild(new Knob({ bus, paramId: 'sampler.master', label: 'MASTER' }).el);
  const bankBar = bankBarFor(engine, 'sampler');
  header.appendChild(bankBar.el);
  header.appendChild(createUndoButton(undo, 'sampler'));
  // The row item is labelled with the slot's filename, so it removes the file
  // too — steps, name and buffer (sampler.md REQ-9). `Clear bank` stays
  // step-only: names are shared by all four banks.
  header.appendChild(clearMenuFor(engine, 'sampler', undo,
    () => [samplerSlotClearRow(engine, undo, cursor.selRow)]));

  const recBtn = document.createElement('button');
  recBtn.className = `${samplerStyles.rec!}`;
  recBtn.dataset.testid = 'sampler-record';
  recBtn.textContent = 'Record a sound';
  recBtn.title = 'Record a sound from your microphone';
  recBtn.addEventListener('click', () => void openRecordSoundModal(engine));
  header.appendChild(recBtn);

  // One cluster so the header breaks between machine controls and FX rather
  // than mid-cluster (responsive-machine-header.md).
  const fx = document.createElement('div');
  fx.className = layout.fxCluster!;
  fx.appendChild(fxGroup(bus, 'DIST', 'fx.sampler.dist', [
    { id: 'fx.sampler.dist.drive', label: 'DRIVE' },
    { id: 'fx.sampler.dist.tone', label: 'TONE' },
    { id: 'fx.sampler.dist.mix', label: 'MIX' },
  ]));
  fx.appendChild(fxGroup(bus, 'PHASER', 'fx.sampler.phaser', [
    { id: 'fx.sampler.phaser.rate', label: 'RATE' },
    { id: 'fx.sampler.phaser.depth', label: 'DEPTH' },
    { id: 'fx.sampler.phaser.feedback', label: 'FB' },
    { id: 'fx.sampler.phaser.mix', label: 'MIX' },
  ]));
  fx.appendChild(fxGroup(bus, 'DELAY', 'fx.sampler.delay', [
    { id: 'fx.sampler.delay.time', label: 'TIME' },
    { id: 'fx.sampler.delay.feedback', label: 'FB' },
    { id: 'fx.sampler.delay.mix', label: 'MIX' },
  ]));
  fx.appendChild(fxGroup(bus, 'REVERB', 'fx.sampler.reverb', [
    { id: 'fx.sampler.reverb.size', label: 'SIZE' },
    { id: 'fx.sampler.reverb.damp', label: 'DAMP' },
    { id: 'fx.sampler.reverb.mix', label: 'MIX' },
  ]));
  // Last, mirroring the sampler chain order (sidechain-ducking.md REQ-8).
  fx.appendChild(fxGroup(bus, 'DUCK', 'fx.sampler.duck', [
    { id: 'fx.sampler.duck.amount', label: 'AMT' },
    { id: 'fx.sampler.duck.attack', label: 'ATK' },
    { id: 'fx.sampler.duck.release', label: 'REL' },
    { id: 'fx.sampler.duck.src', label: 'SRC' },
  ]));
  header.appendChild(fx);

  root.appendChild(header);

  // Declared here rather than beside wirePlayhead below, because the ruler is
  // built before the grid and needs the same gate.
  const gate = new VisibilityGate();

  // ---- Transport-position ruler (transport-position.md REQ-9) ----
  // Outside the rest-overlay wrapper on purpose: a rest bar dims the *pattern*,
  // but where the transport is stays readable.
  const ruler = playheadRulerFor(engine, bus, 'sampler', gate);
  const rulerRow = document.createElement('div');
  rulerRow.className = drumStyles.row!;
  const rulerCtrls = document.createElement('div');
  rulerCtrls.className = drumStyles.rowCtrls!;
  rulerCtrls.style.width = SLOT_CTRLS_WIDTH;
  rulerCtrls.appendChild(ruler.barEl);
  rulerRow.appendChild(rulerCtrls);
  ruler.cellsEl.classList.add(drumStyles.cells!);
  rulerRow.appendChild(ruler.cellsEl);
  root.appendChild(rulerRow);

  // ---- Slot rows ----
  const grid = document.createElement('div');
  grid.className = drumStyles.grid!;
  const { el: gridWrap, restOverlay } = wrapGridWithRestOverlay(engine, 'sampler', bankBar, grid);
  root.appendChild(gridWrap);

  const stepBtns: StepButton[][] = [];
  const cellRows: HTMLElement[] = [];
  const labels: HTMLButtonElement[] = [];
  const editBtns: HTMLButtonElement[] = [];
  const fitBtns: HTMLButtonElement[] = [];

  /**
   * The nearest musical length for a clip, among quarter-bar to four bars
   * (time-stretch.md REQ-11), or `null` when none is reachable inside the stretch
   * limits.
   *
   * Nearest, deliberately, rather than "one bar": a 3.9-bar loop forced into one
   * bar is a 0.26x smear, and the one-click action has no dialog in which to warn
   * about that. Picking the closest length instead keeps the ratio near 1 wherever
   * the clip was already roughly musical, which is the case this button exists for.
   */
  const fitPlan = (buf: AudioBuffer | null): { frames: number; label: string; ratio: number } | null => {
    if (!buf || buf.length === 0) return null;
    const sixteenth = engine.clock.sixteenthDuration();
    const bar = Math.max(1, engine.barTicks);
    if (!Number.isFinite(sixteenth) || sixteenth <= 0) return null;

    const options: { bars: number; label: string }[] = [
      { bars: 0.25, label: '¼ bar' },
      { bars: 0.5, label: '½ bar' },
      { bars: 1, label: '1 bar' },
      { bars: 2, label: '2 bars' },
      { bars: 4, label: '4 bars' },
    ];
    let best: { frames: number; label: string; ratio: number } | null = null;
    for (const o of options) {
      const frames = Math.round(o.bars * bar * sixteenth * buf.sampleRate);
      if (frames <= 0) continue;
      const ratio = frames / buf.length;
      if (ratio < MIN_STRETCH_RATIO || ratio > MAX_STRETCH_RATIO) continue;
      if (!best || Math.abs(Math.log(ratio)) < Math.abs(Math.log(best.ratio))) {
        best = { frames, label: o.label, ratio };
      }
    }
    return best;
  };

  /**
   * Retime a slot to its nearest musical length, and offer the previous audio back
   * (time-stretch.md REQ-12). No confirm: a confirm would defeat a one-click
   * action, and the toast makes it reversible instead. The clip keeps its name —
   * same sound, new timing — which also avoids sampler.md REQ-7 evicting the audio
   * this just wrote.
   *
   * The DSP is loaded on the click that needs it, like the editor modal above
   * (runtime-performance.md REQ-1): most players never press this.
   */
  const quickFit = async (slot: number): Promise<void> => {
    const prev = engine.sampler.buffers[slot] ?? null;
    const plan = fitPlan(prev);
    if (!prev || !plan) return;

    let m: typeof import('../../audio/recorder/time-stretch');
    try {
      m = await import('../../audio/recorder/time-stretch');
    } catch {
      // Deliberately NOT `showLazyLoadFailure`: this import sits inside an
      // *operation*, not behind a surface that opens, and
      // lazy-load-failure.md REQ-5 keeps those with their own feature and their
      // own sentence — "Couldn't open the time-stretcher" describes nothing the
      // user asked for. Same shape as the `lamejs` and `jsqr` deferrals.
      showToast({
        message: navigator.onLine
          ? "Couldn't fit the clip — the download failed."
          : "Couldn't fit the clip — you're offline and this part of the app isn't "
            + 'downloaded yet.',
        actionLabel: 'Retry',
        testId: 'fit-load-failed-toast',
        onAction: () => void quickFit(slot),
      });
      return;
    }
    // The slot may have been reloaded or cleared while the chunk was in flight.
    if (engine.sampler.buffers[slot] !== prev) return;

    const out = m.fitToFrames(audioBufferToCaptured(prev), plan.frames, 'rhythmic');
    engine.sampler.setBuffer(slot, capturedToAudioBuffer(engine.ctx, out));
    refreshLabel(slot);
    showToast({
      message: `Fitted to ${plan.label} · ${plan.ratio.toFixed(2)}x`,
      actionLabel: 'Undo',
      testId: 'fit-toast',
      onAction: () => {
        engine.sampler.setBuffer(slot, prev);
        refreshLabel(slot);
      },
    });
  };

  // Selection cursor for the per-step edit row (one cell across the grid).
  const cursor = new GridCursor(stepBtns, () => {
    renderSelected();
    renderSlotStrip();
    editor.refresh();
  });
  const setSelected = (sl: number, st: number): void => cursor.set(sl, st);

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
    const editBtn = editBtns[slot];
    if (editBtn) editBtn.style.display = loaded ? '' : 'none';

    // The FIT button shares the edit button's visibility rule, and states what it
    // will actually do — the target moves with the tempo, the meter and the clip.
    const fitBtn = fitBtns[slot];
    if (fitBtn) {
      fitBtn.style.display = loaded ? '' : 'none';
      const plan = fitPlan(engine.sampler.buffers[slot] ?? null);
      fitBtn.disabled = plan == null;
      fitBtn.title = plan
        ? `Fit to ${plan.label} — ${plan.ratio.toFixed(2)}x, pitch unchanged`
        : `This clip is more than ${MAX_STRETCH_RATIO}x away from every bar length `
          + 'at this tempo — open the editor to pick a target.';
    }
  };

  for (let t = 0; t < SAMPLER_SLOT_COUNT; t++) {
    const slot = t;
    const row = document.createElement('div');
    row.className = drumStyles.row!;

    const ctrls = document.createElement('div');
    ctrls.className = drumStyles.rowCtrls!;
    ctrls.style.width = SLOT_CTRLS_WIDTH;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.wav,.mp3';
    fileInput.style.display = 'none';
    fileInput.dataset.testid = `sampler-file-${slot}`;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const buf = await engine.ctx.decodeAudioData(await f.arrayBuffer());
        engine.sampler.setBuffer(slot, buf);
        engine.patterns.setSampleName(slot, f.name);
      } catch {
        await alertDialog({
          title: 'Load failed',
          message: 'Unsupported or corrupt audio file.',
          copyable: buildFailureReportFor('Load failed', 'Unsupported or corrupt audio file.', f.name),
          copyLabel: 'Copy error',
        });
      }
      fileInput.value = '';
    });

    const loadBtn = document.createElement('button');
    loadBtn.className = samplerStyles.load!;
    loadBtn.dataset.testid = `sampler-load-${slot}`;
    loadBtn.textContent = 'Load';
    loadBtn.title = 'Load a WAV/MP3 file into this slot';
    loadBtn.addEventListener('click', () => fileInput.click());
    ctrls.appendChild(loadBtn);

    const label = document.createElement('button');
    label.className = samplerStyles.name!;
    label.dataset.testid = `sampler-name-${slot}`;
    label.addEventListener('click', () => engine.sampler.triggerSlot(slot, 0.9));
    labels[slot] = label;
    ctrls.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.className = samplerStyles.edit!;
    editBtn.dataset.testid = `sampler-edit-${slot}`;
    editBtn.innerHTML = UI_ICONS.edit;
    editBtn.title = 'Edit this sample';
    editBtn.style.display = 'none';
    editBtn.addEventListener('click', () => {
      const buf = engine.sampler.buffers[slot];
      if (!buf) return;
      void openRecordSoundModal(engine, { slot, source: audioBufferToCaptured(buf) });
    });
    editBtns[slot] = editBtn;
    ctrls.appendChild(editBtn);

    const fitBtn = document.createElement('button');
    fitBtn.className = samplerStyles.fit!;
    fitBtn.dataset.testid = `sampler-fit-${slot}`;
    fitBtn.textContent = 'FIT';
    fitBtn.style.display = 'none';
    fitBtn.addEventListener('click', () => void quickFit(slot));
    fitBtns[slot] = fitBtn;
    ctrls.appendChild(fitBtn);

    const mute = new Switch(bus, `sampler.t${slot}.mute`, 'mute');
    mute.el.classList.add(drumStyles.mute!);
    ctrls.appendChild(mute.el);

    ctrls.appendChild(fileInput);
    row.appendChild(ctrls);

    const cells = document.createElement('div');
    cells.className = drumStyles.cells!;
    cellRows.push(cells);
    const trackBtns: StepButton[] = [];
    // Every cell is built; `bindLaneGrid` below decides which are live and where
    // the beat accents fall, so the meter owns both (meter.md REQ-8/REQ-11).
    for (let s = 0; s < ALL_CELLS; s++) {
      const cell = engine.patterns.sampler[slot]![s]!;
      const sb = new StepButton('');
      sb.el.dataset.testid = `sampler-step-${slot}-${s}`;
      sb.el.classList.add(StepButton.drumCellClass);
      paintTriggerCell(sb, cell);
      cells.appendChild(sb.el);
      trackBtns.push(sb);
    }
    stepBtns.push(trackBtns);
    row.appendChild(cells);
    grid.appendChild(row);

    refreshLabel(slot);
  }

  // Column count, live cells and beat accents, all from the meter. Bound after
  // the rows exist, because it paints immediately. Not unsubscribed: the panel
  // is built once and lives as long as the page does.
  bindLaneGrid(bus, 'sampler', () => cellRows, () => stepBtns);

  // The shared gesture model (step-grid-editing.md): tap toggles, drag paints,
  // long-press / right-click selects only. Attached after the rows are built so
  // every cell exists, and before the first repaint.
  attachGridGestures({
    cells: stepBtns.map((row) => row.map((sb) => sb.el)),
    isOn: (sl, s) => engine.patterns.sampler[sl]?.[s]?.on ?? false,
    onToggle: (sl, s, on) => engine.patterns.setSamplerCell(sl, s, { on }),
    onSelect: setSelected,
    heldClass: StepButton.heldClass,
  });

  // ---- Selected-slot strip (sound design for the selected slot) ----
  // The drum panel's tuning strip, applied to a sampler slot (sampler.md REQ-12/13):
  // one shared row driven by the selection cursor. Per-row knobs were the obvious
  // alternative and are the wrong one — the row controls are a fixed narrow width and would
  // have to hold nine knobs and a switch, eight times over.
  // `help` pins an info badge to this control's CELL (onboarding.md REQ-25). Only
  // the controls a player cannot guess carry one, and each covers its neighbours:
  // START speaks for END, DECAY for ATK, TONE for RES.
  const SLOT_PARAMS: { suffix: string; label: string; help?: string }[] = [
    { suffix: 'pitch', label: 'PITCH', help: 'sampler.pitch' },
    { suffix: 'start', label: 'START', help: 'sampler.window' },
    { suffix: 'end', label: 'END' },
    { suffix: 'attack', label: 'ATK' },
    { suffix: 'decay', label: 'DECAY', help: 'sampler.env' },
    { suffix: 'tone', label: 'TONE', help: 'sampler.tone' },
    { suffix: 'res', label: 'RES' },
    { suffix: 'pan', label: 'PAN' },
    { suffix: 'vol', label: 'VOL' },
  ];
  const CHOKE_LABELS = ['off', '1', '2', '3', '4'];
  const slotName = (slot: number): string =>
    engine.patterns.sampleNames[slot] ?? SAMPLER_SLOT_LABELS[slot] ?? `S${slot + 1}`;

  const strip = document.createElement('div');
  strip.className = drumStyles.tuning!;
  const stripLabel = document.createElement('div');
  stripLabel.className = editStyles.selectedLabel!;
  const stripKnobs = document.createElement('div');
  stripKnobs.className = samplerStyles.slotKnobs!;
  let stripCells: Knob[] = [];
  let stripRev: Switch | null = null;
  let stripMono: Switch | null = null;
  let stripChoke: ParamDropdown | null = null;
  let stripSlot = -1;

  /**
   * One persistent cell per control, built ONCE and never replaced.
   *
   * The controls inside are rebuilt on every slot change — a `Knob` binds its
   * paramId at construction — but the cells are not, and that is the whole point:
   * `InfoBadges` resolves each anchor when the badges are switched on and then
   * *keeps the element*. A badge pinned to `knob-sampler.t0.pitch` would be
   * holding a detached node the moment the cursor moved to another slot, measure
   * 0x0, and silently vanish (onboarding.md REQ-25).
   */
  const cellFor = (help?: string): HTMLElement => {
    const cell = document.createElement('div');
    cell.className = samplerStyles.slotCell!;
    if (help) cell.dataset.help = help;
    stripKnobs.appendChild(cell);
    return cell;
  };
  const knobCells = SLOT_PARAMS.map((p) => cellFor(p.help));
  const revCell = cellFor();
  const monoCell = cellFor();
  const chokeCell = cellFor();
  // A dropdown, not a knob: a choke group is a name, not a quantity, and a knob
  // that landed between "2" and "3" would be a lie about what it sets.
  const chokeLabel = document.createElement('span');
  chokeLabel.className = drumStyles.kitLabel!;
  chokeLabel.textContent = 'CHOKE';
  // The badge anchors here rather than on the cell, and covers MONO beside it.
  chokeLabel.dataset.help = 'sampler.choke';
  chokeLabel.title = 'Slots sharing a group cut each other — open hat / closed hat';
  const chokePick = document.createElement('div');
  chokePick.className = samplerStyles.chokePick!;
  chokeCell.append(chokeLabel, chokePick);
  function renderSlotStrip(): void {
    // The knobs bind per-slot paramIds, so the strip only needs rebuilding when the
    // selected SLOT changes — not on every step click within it.
    if (cursor.selRow === stripSlot) return;
    stripSlot = cursor.selRow;
    for (const k of stripCells) k.destroy();
    stripCells = [];
    stripRev?.destroy();
    stripMono?.destroy();
    stripChoke?.destroy();
    stripLabel.textContent = `${slotName(cursor.selRow)} — sound`;
    // Only the CONTENTS of each cell are replaced; the cells themselves outlive
    // every slot change so the badges anchored to them stay put.
    SLOT_PARAMS.forEach(({ suffix, label }, i) => {
      const cell = knobCells[i];
      if (!cell) return;
      cell.replaceChildren();
      const knob = new Knob({ bus, paramId: `sampler.t${cursor.selRow}.${suffix}`, label, size: 34 });
      stripCells.push(knob);
      cell.appendChild(knob.el);
    });
    revCell.replaceChildren();
    stripRev = new Switch(bus, `sampler.t${cursor.selRow}.rev`, 'REV');
    stripRev.el.title = 'Play this slot backwards';
    revCell.appendChild(stripRev.el);
    monoCell.replaceChildren();
    stripMono = new Switch(bus, `sampler.t${cursor.selRow}.poly`, 'MONO');
    stripMono.el.title = 'Retriggering this slot cuts its own previous hit';
    monoCell.appendChild(stripMono.el);
    chokePick.replaceChildren();
    stripChoke = new ParamDropdown(bus, `sampler.t${cursor.selRow}.choke`, CHOKE_LABELS);
    chokePick.appendChild(stripChoke.el);
  }
  const stripReset = createButton({
    label: 'Reset',
    testId: 'sampler-slot-reset',
    onClick: () => {
      // Same baseline a knob's double-tap uses: the loaded preset/song value, else
      // the default (param-reset-baseline.md).
      for (const { suffix } of SLOT_PARAMS) bus.reset(`sampler.t${cursor.selRow}.${suffix}`);
      for (const suffix of ['rev', 'poly', 'choke']) {
        bus.reset(`sampler.t${cursor.selRow}.${suffix}`);
      }
    },
  });
  strip.appendChild(stripLabel);
  strip.appendChild(stripKnobs);
  strip.appendChild(stripReset);
  root.appendChild(strip);

  // ---- Per-step edit row (shared component; below the grid) ----
  const editor = new StepSettingsEditor({
    testidPrefix: 'sampler',
    get: () => engine.patterns.sampler[cursor.selRow]?.[cursor.selCol],
    set: (p) => engine.patterns.setSamplerCell(cursor.selRow, cursor.selCol, p),
  });
  const selectedLabel = document.createElement('div');
  selectedLabel.className = editStyles.selectedLabel!;
  const renderSelected = () => {
    const name = engine.patterns.sampleNames[cursor.selRow] ?? SAMPLER_SLOT_LABELS[cursor.selRow] ?? `S${cursor.selRow + 1}`;
    selectedLabel.textContent = `${name} · step ${cursor.selCol + 1}`;
  };
  editor.el.insertBefore(selectedLabel, editor.el.firstChild);
  root.appendChild(editor.el);
  setSelected(0, 0);

  const highlighter = wirePlayhead(engine, 'sampler', stepBtns, restOverlay, gate);

  // Full bank repaint (bank switch / song restore)
  engine.patterns.onSamplerBankChange((bank) => {
    highlighter.clear();
    for (let s = 0; s < SAMPLER_SLOT_COUNT; s++) {
      for (let i = 0; i < ALL_CELLS; i++) {
        const sb = stepBtns[s]?.[i];
        if (sb) paintTriggerCell(sb, bank[s]![i]!);
      }
    }
    editor.refresh();
  });

  // Live step edit updates
  engine.patterns.onSamplerChange((slot, step, cell) => {
    const sb = stepBtns[slot]?.[step];
    if (sb) paintTriggerCell(sb, cell);
    if (slot === cursor.selRow && step === cursor.selCol) editor.refresh();
  });

  // Filename / load-state changes
  engine.patterns.onSampleMetaChange((slot) => {
    refreshLabel(slot);
    if (slot === cursor.selRow) {
      renderSelected();
      stripLabel.textContent = `${slotName(slot)} — sound`;
    }
  });

  return {
    el: root,
    gate,
    clearSelectedStep: () => engine.patterns.setSamplerCell(cursor.selRow, cursor.selCol, { on: false }),
  };
}
