import type { ParamBus } from '../../state/params';
import type { XyPadStore } from '../../state/xy-pad';
import type { StudioApi } from '../studio-api';
import type { XyPadWindowController } from '../components/xy-pad-window';
import { Switch } from '../components/switch';
import { Segmented } from '../components/segmented';
import { Dropdown } from '../components/dropdown';
import { BankBar } from '../components/bank-bar';
import { MotionStepPad } from '../components/motion-step-pad';
import { motionGraphPoints } from '../components/motion-graph';
import { PlayheadHighlighter } from '../components/playhead-highlighter';
import { buildRestOverlay } from '../components/rest-overlay';
import { xyPadLaunchButton } from '../components/live-fx';
import { SEQ_LENGTH, type MotionStep } from '../../state/patterns';
import layout from '../styles/layout.module.css';
import switchStyles from '../styles/switch.module.css';
import drumStyles from '../styles/drum.module.css';
import segmentedStyles from '../styles/segmented.module.css';
import styles from '../styles/motion.module.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Motion sequencer panel (specs/features/motion-sequencer.md): 16 mini XY
 * pads per bank — drag sets an anchor, double-click clears — with an SVG
 * polyline tracing the selected axis (Y default) across the steps, per-bank
 * axis-override dropdowns, Slide/Step mode, and the standard BankBar /
 * playhead / rest-overlay plumbing.
 */
export function buildMotionPanel(
  bus: ParamBus,
  engine: StudioApi,
  xy: XyPadStore,
  xyWin: XyPadWindowController,
): HTMLElement {
  const root = document.createElement('div');
  root.className = layout.patternPanel!;
  const patterns = engine.patterns;

  // Which axis the graph traces — a local view state, never persisted (REQ-8).
  let view: 'x' | 'y' = 'y';

  // ---- Header ----
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'motion.on', 'motion').el);
  header.appendChild(new Segmented(bus, 'motion.slide', ['STEP', 'SLIDE']).el);

  const viewSel = document.createElement('div');
  viewSel.className = segmentedStyles.root!;
  viewSel.dataset.testid = 'motion-view';
  (['x', 'y'] as const).forEach((axis) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = axis.toUpperCase();
    b.dataset.testid = `motion-view-${axis}`;
    b.title = `Graph the ${axis.toUpperCase()} param across the bar`;
    if (axis === view) b.classList.add('active');
    b.addEventListener('click', () => {
      view = axis;
      for (const c of Array.from(viewSel.children)) c.classList.remove('active');
      b.classList.add('active');
      redrawGraph();
      refreshAxes();
    });
    viewSel.appendChild(b);
  });
  header.appendChild(viewSel);

  const bankBar = new BankBar({
    getEdit: () => patterns.motionEditBank,
    setEdit: (i) => patterns.setMotionEditBank(i),
    copy: (f, t) => patterns.copyMotionBank(f, t),
    onEditChange: (fn) => patterns.onEditBankChange(fn),
    getPlay: () => engine.arrangement.motionPlayBank,
    onPlayChange: (fn) => engine.arrangement.onChange(fn),
    hasContent: (i) => patterns.motionBanks[i]!.some((s) => s.on),
    onContentChange: (fn) => patterns.onMotionChange(fn),
    testidPrefix: 'motion',
  });
  header.appendChild(bankBar.el);
  header.appendChild(xyPadLaunchButton(xyWin, 'motion-xypad'));
  root.appendChild(header);

  // ---- Step grid: one row of 16 mini XY pads ----
  const cells = document.createElement('div');
  cells.className = drumStyles.cells!;
  const pads: MotionStepPad[] = [];
  for (let s = 0; s < SEQ_LENGTH; s++) {
    const step = s;
    const pad = new MotionStepPad({
      beat: s % 4 === 0,
      onSet: (px, py) => patterns.setMotionStep(step, { on: true, x: px, y: py }),
      onClear: () => patterns.setMotionStep(step, { on: false }),
    });
    pad.el.dataset.testid = `motion-step-${s}`;
    pad.setStep(patterns.motion[s]!);
    cells.appendChild(pad.el);
    pads.push(pad);
  }

  // The selected-axis graph, drawn over the whole row (pointer-events: none).
  const graph = document.createElementNS(SVG_NS, 'svg');
  graph.setAttribute('class', styles.graph!);
  graph.setAttribute('viewBox', '0 0 100 100');
  graph.setAttribute('preserveAspectRatio', 'none');
  graph.dataset.testid = 'motion-graph';

  const gridWrap = document.createElement('div');
  gridWrap.style.position = 'relative';
  gridWrap.appendChild(cells);
  gridWrap.appendChild(graph);
  const restOverlay = buildRestOverlay(engine, 'motion', { following: () => bankBar.following });
  gridWrap.appendChild(restOverlay.el);
  bankBar.onFollowChange(() => restOverlay.refresh());
  root.appendChild(gridWrap);

  const redrawGraph = (): void => {
    graph.innerHTML = '';
    // Mode-aware line (REQ-8): slide = anchor polyline; step = the true
    // jump-and-hold staircase, so the graph matches what valueAt will play.
    const mode = bus.get('motion.slide') >= 0.5 ? 'slide' : 'step';
    const { line, dots } = motionGraphPoints(patterns.motion, view, mode);
    if (line.length > 1) {
      const poly = document.createElementNS(SVG_NS, 'polyline');
      poly.setAttribute('points', line.map(([px, py]) => `${px},${py}`).join(' '));
      graph.appendChild(poly);
    }
    for (const [px, py] of dots) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(px));
      c.setAttribute('cy', String(py));
      c.setAttribute('r', '1.1');
      graph.appendChild(c);
    }
  };

  // ---- Axes row: the edit bank's effective assignment (override or inherit) ----
  const axes = document.createElement('div');
  axes.className = styles.axes!;
  const paramIds = bus.ids().slice().sort();

  const mkAxis = (axis: 'x' | 'y'): Dropdown => {
    const label = document.createElement('span');
    label.className = styles.axisLabel!;
    label.textContent = axis.toUpperCase();
    axes.appendChild(label);
    const sel = new Dropdown(paramIds, xy.get()[axis]);
    sel.el.dataset.testid = `motion-assign-${axis}`;
    sel.onChange((id) => {
      const ov = patterns.motionAssign(patterns.motionEditBank) ?? {};
      patterns.setMotionAssign({ ...ov, [axis]: id });
    });
    axes.appendChild(sel.el);
    return sel;
  };
  const xSel = mkAxis('x');
  const ySel = mkAxis('y');

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = switchStyles.root!;
  resetBtn.dataset.testid = 'motion-assign-reset';
  resetBtn.textContent = '↺ inherit';
  resetBtn.title = "Clear this bank's override and follow the XY Pad assignment";
  resetBtn.addEventListener('click', () => patterns.setMotionAssign(null));
  axes.appendChild(resetBtn);

  const hint = document.createElement('span');
  hint.className = styles.hint!;
  axes.appendChild(hint);
  root.appendChild(axes);

  const refreshAxes = (): void => {
    const ov = patterns.motionAssign(patterns.motionEditBank);
    const base = xy.get();
    xSel.setValue(ov?.x ?? base.x);
    ySel.setValue(ov?.y ?? base.y);
    xSel.el.classList.toggle(styles.inheritedSel!, !ov?.x);
    ySel.el.classList.toggle(styles.inheritedSel!, !ov?.y);
    resetBtn.style.visibility = ov ? '' : 'hidden';
    const effective = view === 'x' ? (ov?.x ?? base.x) : (ov?.y ?? base.y);
    hint.textContent = ov
      ? `bank override — graph: ${effective}`
      : `inherited from XY Pad — graph: ${effective}`;
  };

  // ---- Wiring ----
  const paintAll = (bank: readonly MotionStep[]): void => {
    for (let s = 0; s < SEQ_LENGTH; s++) pads[s]!.setStep(bank[s]!);
    redrawGraph();
    refreshAxes();
  };

  const highlighter = new PlayheadHighlighter([pads]);
  engine.motion.onStep((idx) => {
    const match = patterns.motionEditBank === engine.arrangement.motionPlayBank;
    highlighter.update(idx, match);
    restOverlay.refresh();
  });

  patterns.onMotionBankChange((bank) => {
    highlighter.clear();
    paintAll(bank);
  });
  patterns.onMotionChange((idx, step) => {
    pads[idx]?.setStep(step);
    redrawGraph();
  });
  xy.onChange(refreshAxes);
  // STEP/SLIDE changes the line's shape (staircase vs ramp) — re-project live.
  bus.subscribe('motion.slide', redrawGraph);

  redrawGraph();
  refreshAxes();
  return root;
}
