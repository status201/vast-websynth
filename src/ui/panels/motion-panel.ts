import type { ParamBus } from '../../state/params';
import type { XyPadStore } from '../../state/xy-pad';
import type { StudioApi } from '../studio-api';
import type { XyPadWindowController } from '../components/xy-pad-window';
import type { PatternUndo } from '../../state/pattern-undo';
import { createUndoButton } from '../components/undo-button';
import { Switch } from '../components/switch';
import { Segmented } from '../components/segmented';
import { Dropdown } from '../components/dropdown';
import { MotionStepPad } from '../components/motion-step-pad';
import { motionGraphPoints, motionGraphPoints1D } from '../components/motion-graph';
import { bankBarFor, wrapGridWithRestOverlay, wirePlayhead, clearMenuFor } from './step-panel-scaffold';
import { xyPadLaunchButton } from '../components/live-fx';
import type { MotionNeighbours, MotionTrackNeighbours } from '../../audio/transport/motion-curve';
import { motionAxesFor } from '../../state/xy-effective';
import {
  REST, SEQ_LENGTH, MOTION_TRACK_COUNT, MOTION_TRACK_LABELS,
  type MotionStep, type MotionTrackStep,
} from '../../state/patterns';
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
  undo: PatternUndo,
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

  const bankBar = bankBarFor(engine, 'motion');
  header.appendChild(bankBar.el);
  header.appendChild(createUndoButton(undo, 'motion'));
  // Motion keeps its own per-pad gestures (step-grid-editing.md REQ-9) — this is
  // the bulk escape hatch, since clearing 16 anchors by double-tapping each is
  // exactly the tedium REQ-6 exists to remove. The bank's axis override survives.
  header.appendChild(clearMenuFor(engine, 'motion', undo));
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

  const { el: gridWrap, restOverlay } =
    wrapGridWithRestOverlay(engine, 'motion', bankBar, cells, graph);
  root.appendChild(gridWrap);

  /**
   * The banks the edit bank's bar sits between in the chain — what its bar-line
   * segments ramp to and from (REQ-2b). A disabled lane (or a bank the chain never
   * plays) loops on itself; a REST neighbour, or one driving other params, carries
   * nothing, matching MotionMachine's own gate.
   */
  const chainNeighbours = (): MotionNeighbours => {
    const edit = patterns.motionEditBank;
    const lane = engine.arrangement.motion;
    const slot = lane.enabled ? lane.steps.indexOf(edit) : -1;
    if (slot < 0) return { prev: patterns.motion, next: patterns.motion };
    const axes = motionAxesFor(patterns, edit, xy.get());
    const at = (i: number): readonly MotionStep[] | null => {
      const n = lane.steps.length;
      const b = lane.steps[((i % n) + n) % n]!;
      if (b === REST) return null;
      const nb = motionAxesFor(patterns, b, xy.get());
      if (nb.x !== axes.x || nb.y !== axes.y) return null;
      return patterns.motionBanks[b]!;
    };
    return { prev: at(slot - 1), next: at(slot + 1) };
  };

  const strokePolylineIn = (svg: SVGElement, pts: Array<[number, number]>, cls?: string): void => {
    const poly = document.createElementNS(SVG_NS, 'polyline');
    poly.setAttribute('points', pts.map(([px, py]) => `${px},${py}`).join(' '));
    if (cls) poly.setAttribute('class', cls);
    svg.appendChild(poly);
  };
  const strokePolyline = (pts: Array<[number, number]>, cls?: string): void =>
    strokePolylineIn(graph, pts, cls);

  /**
   * The neighbouring bars' same-index track, for an extra track's bar-line carry
   * (REQ-14) — mirroring `chainNeighbours` for the axes. A neighbour driving a
   * different param carries nothing, matching MotionMachine's own gate.
   */
  const trackNeighbours = (track: number, param: string | undefined): MotionTrackNeighbours => {
    const self = patterns.motionTrack(track)?.steps ?? [];
    if (!param) return { prev: self, next: self };
    const edit = patterns.motionEditBank;
    const lane = engine.arrangement.motion;
    const slot = lane.enabled ? lane.steps.indexOf(edit) : -1;
    if (slot < 0) return { prev: self, next: self };
    const at = (i: number): readonly MotionTrackStep[] | null => {
      const n = lane.steps.length;
      const b = lane.steps[((i % n) + n) % n]!;
      if (b === REST) return null;
      const nb = patterns.motionTracks(b)[track];
      return nb && nb.param === param ? nb.steps : null;
    };
    return { prev: at(slot - 1), next: at(slot + 1) };
  };

  const redrawGraph = (): void => {
    graph.innerHTML = '';
    // Mode-aware line (REQ-8): slide = anchor polyline; step = the true
    // jump-and-hold staircase, so the graph matches what valueAt will play.
    const mode = bus.get('motion.slide') >= 0.5 ? 'slide' : 'step';
    const { line, dots, carry } =
      motionGraphPoints(patterns.motion, view, mode, chainNeighbours());
    // Dashed first, so the solid in-bar line wins where they meet.
    for (const seg of carry) strokePolyline(seg, styles.carry!);
    if (line.length > 1) strokePolyline(line);
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

  // ---- Extra single-param tracks (REQ-13/REQ-16) ----
  // One row per track: a param picker plus 16 level cells sharing the XY pads'
  // gesture family (drag = set, double-tap = clear) via MotionStepPad's level
  // mode, and the same mode-aware polyline so slide interpolation and the
  // bar-line carry stay visible while authoring.
  const NONE = '— none —';
  const buildTrackRow = (track: number): { repaint: () => void } => {
    const row = document.createElement('div');
    row.className = styles.trackRow!;

    const ctrls = document.createElement('div');
    ctrls.className = styles.trackCtrls!;
    const label = document.createElement('span');
    label.className = styles.trackLabel!;
    label.textContent = MOTION_TRACK_LABELS[track] ?? String(track + 1);
    ctrls.appendChild(label);

    const picker = new Dropdown([NONE, ...paramIds], NONE);
    picker.el.dataset.testid = `motion-trk-${track}-param`;
    picker.onChange((id) => patterns.setMotionTrackParam(track, id === NONE ? null : id));
    ctrls.appendChild(picker.el);
    row.appendChild(ctrls);

    const cells = document.createElement('div');
    cells.className = drumStyles.cells!;
    const pads: MotionStepPad[] = [];
    for (let sIdx = 0; sIdx < SEQ_LENGTH; sIdx++) {
      const step = sIdx;
      const pad = new MotionStepPad({
        beat: sIdx % 4 === 0,
        mode: 'level',
        onSet: (_x, y) => patterns.setMotionTrackStep(track, step, { on: true, v: y }),
        onClear: () => patterns.setMotionTrackStep(track, step, { on: false }),
      });
      pad.el.dataset.testid = `motion-trk-${track}-step-${sIdx}`;
      cells.appendChild(pad.el);
      pads.push(pad);
    }

    const graph = document.createElementNS(SVG_NS, 'svg');
    graph.setAttribute('class', styles.graph!);
    graph.setAttribute('viewBox', '0 0 100 100');
    graph.setAttribute('preserveAspectRatio', 'none');
    graph.dataset.testid = `motion-trk-${track}-graph`;

    const grid = document.createElement('div');
    grid.className = styles.trackGrid!;
    grid.appendChild(cells);
    grid.appendChild(graph);
    row.appendChild(grid);
    root.appendChild(row);

    const repaint = (): void => {
      const t = patterns.motionTrack(track);
      if (!t) return;
      const assigned = !!t.param;
      picker.setValue(t.param ?? NONE);
      // Only the CELLS go inert — never the row, which holds the param picker.
      // Disabling that is the one thing that would make an unassigned track
      // impossible to assign (ADR-014 law 2: no dead ends).
      row.classList.toggle(styles.trackDim!, !assigned);
      for (let i = 0; i < SEQ_LENGTH; i++) {
        const cell = t.steps[i]!;
        pads[i]!.setLevel(cell.on, cell.v, t.param);
        pads[i]!.setInert(!assigned);
      }
      graph.innerHTML = '';
      const mode = bus.get('motion.slide') >= 0.5 ? 'slide' : 'step';
      const { line, dots, carry } =
        motionGraphPoints1D(t.steps, mode, trackNeighbours(track, t.param));
      for (const seg of carry) strokePolylineIn(graph, seg, styles.carry!);
      if (line.length > 1) strokePolylineIn(graph, line);
      for (const [px, py] of dots) {
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', String(px));
        c.setAttribute('cy', String(py));
        c.setAttribute('r', '1.1');
        graph.appendChild(c);
      }
    };
    return { repaint };
  };

  const trackRows = Array.from({ length: MOTION_TRACK_COUNT }, (_, t) => buildTrackRow(t));
  const repaintTracks = (): void => { for (const r of trackRows) r.repaint(); };
  patterns.onMotionTrackChange(repaintTracks);
  bus.subscribe('motion.slide', repaintTracks);
  engine.arrangement.onChange(repaintTracks);

  // ---- Wiring ----
  const paintAll = (bank: readonly MotionStep[]): void => {
    for (let s = 0; s < SEQ_LENGTH; s++) pads[s]!.setStep(bank[s]!);
    redrawGraph();
    refreshAxes();
  };

  const highlighter = wirePlayhead(engine, 'motion', [pads], restOverlay);

  patterns.onMotionBankChange((bank) => {
    highlighter.clear();
    paintAll(bank);
  });
  patterns.onMotionChange((idx, step) => {
    pads[idx]?.setStep(step);
    redrawGraph();
  });
  xy.onChange(() => {
    refreshAxes();
    redrawGraph(); // a base reassignment can change which neighbours carry
  });
  // STEP/SLIDE changes the line's shape (staircase vs ramp) — re-project live.
  bus.subscribe('motion.slide', redrawGraph);
  // Chain edits (and each bar's advance) move which banks border this one.
  engine.arrangement.onChange(redrawGraph);

  redrawGraph();
  refreshAxes();
  return root;
}
