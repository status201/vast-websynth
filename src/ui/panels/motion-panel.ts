import type { ParamBus } from '../../state/params';
import type { XyAssign, XyPadStore } from '../../state/xy-pad';
import type { StudioApi } from '../studio-api';
import type { XyPadWindowController } from '../components/xy-pad-window';
import type { PatternUndo } from '../../state/pattern-undo';
import type { UiBridge } from '../ui-bridge';
import { createUndoButton } from '../components/undo-button';
import { Switch } from '../components/switch';
import { Segmented } from '../components/segmented';
import { Dropdown } from '../components/dropdown';
import { MotionStepPad, type MotionGesture } from '../components/motion-step-pad';
import { showValueBubble, hideValueBubble } from '../components/value-bubble';
import { formatParam } from '../format-param';
import { fromNorm } from '../../utils/taper';
import { motionGraphPoints, motionGraphPoints1D } from '../components/motion-graph';
import {
  bankBarFor, wrapGridWithRestOverlay, wirePlayhead, playheadRulerFor, laneControlsFor, laneMeterControlsFor, clearMenuFor,
  VisibilityGate, type ClearRow, type GatedPanel,
} from './step-panel-scaffold';
import { xyPadLaunchButton } from '../components/live-fx';
import type { MotionNeighbours, MotionTrackNeighbours } from '../../audio/transport/motion-curve';
import { motionAxesFor } from '../../state/xy-effective';
import {
  REST, MOTION_TRACK_COUNT, MOTION_TRACK_LABELS, MOTION_TRACK_STEP_DEFAULTS,
  type MotionStep, type MotionTrackStep,
} from '../../state/patterns';
import { ALL_CELLS, bindLaneGrid, laneGrid, onLaneGridChange } from '../lane-grid';
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
  bridge: UiBridge,
): GatedPanel {
  const root = document.createElement('div');
  root.className = layout.patternPanel!;
  const patterns = engine.patterns;

  // Which axis the graph traces — a local view state, never persisted (REQ-8).
  let view: 'x' | 'y' = 'y';

  // ---- Header ----
  const header = document.createElement('div');
  header.className = layout.patternPanelHeader!;
  header.appendChild(new Switch(bus, 'motion.on', 'motion').el);
  // Chain / Mute / Solo, right after the machine switch — the same three
  // controls the Song tab's lane card carries (machine-status.md REQ-9).
  header.appendChild(laneControlsFor(bus, engine, 'motion', bridge).el);
  header.appendChild(laneMeterControlsFor(bus, 'motion').el);

  // ---- XY lane header (REQ-8) ----
  // Everything that belongs to the XY lane rather than the machine: its
  // launcher, its graph projection toggle, its interpolation mode, the axes it
  // drives and the hint reading them back — one row, directly above its pads.
  const xyHeader = document.createElement('div');
  xyHeader.className = styles.xyHeader!;
  // Anchor for the short XY-lane help badge (onboarding.md REQ-14).
  xyHeader.dataset.help = 'motion.xy';
  xyHeader.appendChild(xyPadLaunchButton(xyWin, 'motion-xypad'));

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
  xyHeader.appendChild(viewSel);
  xyHeader.appendChild(new Segmented(bus, 'motion.slide', ['STEP', 'SLIDE']).el);

  // ---- Per-lane value readout (REQ-22) ----
  // The pads are ~40px wide and there are 48 of them, so a step's value cannot
  // live on the cell. Each lane gets one readout in its own header instead —
  // permanent chrome, the Knob's `.num` pattern, which is what ADR-014 law 6
  // asks for in place of a hover-only tooltip. The same string also feeds the
  // drag bubble, so the two can never disagree.
  const EMPTY_READOUT = '—';
  /** True while any pad on any lane owns a gesture — hover must not fight it. */
  let gesturing = false;

  const makeReadout = (testId: string): HTMLElement => {
    const el = document.createElement('span');
    el.className = styles.readout!;
    el.dataset.testid = testId;
    el.textContent = EMPTY_READOUT;
    return el;
  };

  /** The edit bank's effective axes — `motionAxesFor` is the one override/inherit
   *  rule (REQ-4), shared with the machine and the graph so all three agree on
   *  which parameter a bank's anchors mean. */
  const effectiveAxes = (): XyAssign =>
    motionAxesFor(patterns, patterns.motionEditBank, xy.get());

  /** A normalized 0..1 as the parameter actually reads, or '' when the lane
   *  drives nothing (an unassigned track, or an id the bus does not know). */
  const paramText = (id: string | undefined, n: number): string => {
    const def = id ? bus.def(id) : undefined;
    return def ? formatParam(def, fromNorm(def, n)) : '';
  };

  /** 1-based, zero-padded: musicians count steps from one. */
  const stepLabel = (s: number): string => String(s + 1).padStart(2, '0');

  /**
   * Render one gesture into a lane's header readout and the floating bubble.
   * `null` ends the gesture: the bubble goes away, the readout **stays** on the
   * step it was showing, which is what lets you read A's value and then compare
   * it while setting B's.
   */
  const applyGesture = (
    readout: HTMLElement,
    anchor: HTMLElement,
    g: MotionGesture | null,
    text: (x: number, y: number) => string,
  ): void => {
    if (!g) {
      gesturing = false;
      readout.classList.remove(styles.readoutLive!);
      hideValueBubble();
      return;
    }
    gesturing = true;
    const s = text(g.x, g.y);
    readout.textContent = s;
    readout.classList.add(styles.readoutLive!);
    showValueBubble(anchor, s, { peek: g.mode === 'peek', testId: 'motion-value-bubble' });
  };

  /** Mouse hover updates the header readout only — never the bubble, which
   *  belongs to a live gesture. Touch has no hover and does not need one: a
   *  hold peeks (REQ-23a). */
  const wireHover = (el: HTMLElement, readout: HTMLElement, text: () => string): void => {
    el.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || gesturing) return;
      readout.textContent = text();
    });
  };

  const bankBar = bankBarFor(engine, 'motion');
  header.appendChild(bankBar.el);
  header.appendChild(createUndoButton(undo, 'motion'));
  // Motion keeps its own per-pad gestures (step-grid-editing.md REQ-9) — this is
  // the bulk escape hatch, since clearing 16 anchors by double-tapping each is
  // exactly the tedium REQ-6 exists to remove. The bank's axis override survives.
  // Motion has no selection cursor, so there is no "selected row" to clear.
  // Instead the menu lists every lane that currently holds steps — offering an
  // already-empty lane would be a dead item (ADR-014 law 1).
  // All three lanes, every time: dropping the empty ones is `clearMenuFor`'s job
  // now, so the rule reads the same on all four machines (step-grid-editing.md
  // REQ-6). Motion just answers `hasContent` per lane.
  header.appendChild(clearMenuFor(engine, 'motion', undo, () => {
    const out: ClearRow[] = [{
      label: 'XY',
      hasContent: patterns.motion.some((st) => st.on),
      clear: () => patterns.clearMotionXy(),
    }];
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      const track = t;
      out.push({
        label: MOTION_TRACK_LABELS[track] ?? String(track + 1),
        hasContent: patterns.motionTrack(track)?.steps.some((st) => st.on) ?? false,
        clear: () => patterns.clearMotionTrack(track),
      });
    }
    return out;
  }));
  // Declared here rather than beside wirePlayhead below, because the ruler is
  // built before the pads and needs the same gate.
  const gate = new VisibilityGate();

  // ---- Transport-position ruler (transport-position.md REQ-9) ----
  // The bar readout belongs to the machine header (position is transport-wide,
  // not an XY-lane setting); the ticks span the full width above the pads, which
  // have no left control column of their own. Outside the rest-overlay wrapper
  // on purpose: a rest bar dims the *pattern*, not where the transport is.
  const ruler = playheadRulerFor(engine, bus, 'motion', gate);
  header.appendChild(ruler.barEl);
  root.appendChild(header);
  // Populated further down by the axes block; placed here so it renders between
  // the machine header and the pads it belongs to.
  root.appendChild(xyHeader);
  ruler.cellsEl.classList.add(drumStyles.cells!);
  root.appendChild(ruler.cellsEl);

  // ---- Step grid: one row of 16 mini XY pads ----
  const cells = document.createElement('div');
  cells.className = drumStyles.cells!;
  const xyReadout = makeReadout('motion-readout-xy');
  /** Both axes at once, each with the value its parameter actually takes. */
  const xyReadoutText = (s: number, x: number, y: number): string => {
    const ax = effectiveAxes();
    const px = paramText(ax.x, x);
    const py = paramText(ax.y, y);
    return `${stepLabel(s)} · x ${x.toFixed(2)}${px ? ` (${px})` : ''}`
      + ` · y ${y.toFixed(2)}${py ? ` (${py})` : ''}`;
  };
  const pads: MotionStepPad[] = [];
  // Every cell is built; `bindLaneGrid` below decides which are live and where
  // the beat accents fall, so the meter owns both (meter.md REQ-8/REQ-11).
  for (let s = 0; s < ALL_CELLS; s++) {
    const step = s;
    const pad = new MotionStepPad({
      onSet: (px, py) => patterns.setMotionStep(step, { on: true, x: px, y: py }),
      onClear: () => patterns.setMotionStep(step, { on: false }),
      onGesture: (g) =>
        applyGesture(xyReadout, pads[step]!.el, g, (x, y) => xyReadoutText(step, x, y)),
    });
    pad.el.dataset.testid = `motion-step-${s}`;
    pad.setStep(patterns.motion[s]!);
    wireHover(pad.el, xyReadout, () => {
      const st = patterns.motion[step]!;
      return xyReadoutText(step, st.x, st.y);
    });
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

  /**
   * The lane's played length — the same `laneGrid` that sets `--steps` on the
   * three grids, so the curve is drawn over exactly the cells beneath it
   * (REQ-24b). Read per redraw rather than captured: the meter changes under a
   * built panel.
   */
  const motionCells = (): number => laneGrid(bus, 'motion').cells;

  const redrawGraph = (): void => {
    graph.innerHTML = '';
    // Mode-aware line (REQ-8): slide = anchor polyline; step = the true
    // jump-and-hold staircase, so the graph matches what valueAt will play.
    const mode = bus.get('motion.slide') >= 0.5 ? 'slide' : 'step';
    const { line, dots, carry } =
      motionGraphPoints(patterns.motion, view, mode, chainNeighbours(), motionCells());
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

  // ---- Axes: the edit bank's effective assignment (override or inherit) ----
  // Appended into the XY lane header above, so the dropdowns and the "graph:"
  // hint sit beside the view toggle that drives them (REQ-8).
  const paramIds = bus.ids().slice().sort();

  const mkAxis = (axis: 'x' | 'y'): Dropdown => {
    const label = document.createElement('span');
    label.className = styles.axisLabel!;
    label.textContent = axis.toUpperCase();
    xyHeader.appendChild(label);
    const sel = new Dropdown(paramIds, xy.get()[axis]);
    sel.el.dataset.testid = `motion-assign-${axis}`;
    sel.onChange((id) => {
      const ov = patterns.motionAssign(patterns.motionEditBank) ?? {};
      patterns.setMotionAssign({ ...ov, [axis]: id });
    });
    xyHeader.appendChild(sel.el);
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
  xyHeader.appendChild(resetBtn);

  const hint = document.createElement('span');
  hint.className = styles.hint!;
  xyHeader.appendChild(hint);
  // Last in the row: the readout reads back what the pads below are doing, so it
  // sits after the controls that decide what those values mean.
  xyHeader.appendChild(xyReadout);

  const refreshAxes = (): void => {
    const ov = patterns.motionAssign(patterns.motionEditBank);
    const ax = effectiveAxes();
    xSel.setValue(ax.x);
    ySel.setValue(ax.y);
    // Dim, not disable: an inherited axis is exactly the one you need to click.
    // `setDimmed` marks the toggle — dimming the root faded the open option list
    // and buried it under the pads (dropdown.md REQ-9).
    xSel.setDimmed(!ov?.x);
    ySel.setDimmed(!ov?.y);
    resetBtn.style.visibility = ov ? '' : 'hidden';
    const effective = view === 'x' ? ax.x : ax.y;
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
  const buildTrackRow = (track: number): { repaint: () => void; pads: MotionStepPad[]; cells: HTMLElement } => {
    const row = document.createElement('div');
    // The first track carries the one divider — A and B are the same kind of
    // lane, so only the XY lane above is fenced off (REQ-8).
    row.className = styles.trackRow! + (track === 0 ? ` ${styles.laneDivider!}` : '');
    // The shared A/B help badge anchors here, on the first track's row
    // (onboarding.md REQ-14).
    if (track === 0) row.dataset.help = 'motion.tracks';

    const ctrls = document.createElement('div');
    ctrls.className = styles.trackHeader!;
    const label = document.createElement('span');
    label.className = styles.trackLabel!;
    label.textContent = MOTION_TRACK_LABELS[track] ?? String(track + 1);
    ctrls.appendChild(label);

    const picker = new Dropdown([NONE, ...paramIds], NONE);
    picker.el.dataset.testid = `motion-trk-${track}-param`;
    picker.onChange((id) => patterns.setMotionTrackParam(track, id === NONE ? null : id));
    ctrls.appendChild(picker.el);
    // This lane's own interpolation mode (REQ-2/REQ-16). Segmented mints
    // `seg-motion.t<i>.slide` itself, so there is no testid to hand-maintain.
    ctrls.appendChild(new Segmented(bus, `motion.t${track}.slide`, ['STEP', 'SLIDE']).el);
    const readout = makeReadout(`motion-readout-trk-${track}`);
    ctrls.appendChild(readout);
    row.appendChild(ctrls);

    // Normalized first — that is the number you match against the other lane —
    // then what the parameter actually reads (REQ-22).
    const readoutText = (s: number, v: number): string => {
      const pt = paramText(patterns.motionTrack(track)?.param, v);
      return `${stepLabel(s)} · ${v.toFixed(2)}${pt ? ` · ${pt}` : ''}`;
    };

    const cells = document.createElement('div');
    // Wider-gap grid than the XY lane's (styles.trackCells vs drumStyles.cells),
    // so the tracks read as a distinct lane (REQ-8/REQ-16).
    cells.className = styles.trackCells!;
    const pads: MotionStepPad[] = [];
    for (let sIdx = 0; sIdx < ALL_CELLS; sIdx++) {
      const step = sIdx;
      const pad = new MotionStepPad({
        mode: 'level',
        onSet: (_x, y) => patterns.setMotionTrackStep(track, step, { on: true, v: y }),
        // Clearing returns the cell to the default step (level included), so a
        // cleared cell reads like an untouched one instead of keeping its old
        // parked height (motion-sequencer.md REQ-16).
        onClear: () => patterns.setMotionTrackStep(track, step, { ...MOTION_TRACK_STEP_DEFAULTS }),
        // Only y is meaningful on a level cell, so only y reaches the readout.
        onGesture: (g) =>
          applyGesture(readout, pads[step]!.el, g, (_x, y) => readoutText(step, y)),
      });
      pad.el.dataset.testid = `motion-trk-${track}-step-${sIdx}`;
      wireHover(pad.el, readout, () => {
        const cell = patterns.motionTrack(track)?.steps[step];
        return cell ? readoutText(step, cell.v) : EMPTY_READOUT;
      });
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
    // Dim this track lane while the motion lane rests, like the XY lane above
    // (arrangement-rest.md REQ-6). The overlay self-wires to arrangement.onChange
    // + bankBar.onFollowChange, so it needs no extra refresh plumbing; the header
    // (ctrls) stays outside the dim so the param picker remains usable.
    const { el: gridWrap } = wrapGridWithRestOverlay(engine, 'motion', bankBar, grid);
    row.appendChild(gridWrap);
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
      // An unassigned lane has no value to convert, so it reports none. An
      // assigned one keeps whatever the readout was last showing — that
      // stickiness is what makes two lanes comparable (REQ-22).
      if (!assigned) readout.textContent = EMPTY_READOUT;
      for (let i = 0; i < ALL_CELLS; i++) {
        const cell = t.steps[i]!;
        pads[i]!.setLevel(cell.on, cell.v, t.param);
        pads[i]!.setInert(!assigned);
      }
      graph.innerHTML = '';
      const mode = bus.get(`motion.t${track}.slide`) >= 0.5 ? 'slide' : 'step';
      const { line, dots, carry } =
        motionGraphPoints1D(t.steps, mode, trackNeighbours(track, t.param), motionCells());
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
    return { repaint, pads, cells };
  };

  const trackRows = Array.from({ length: MOTION_TRACK_COUNT }, (_, t) => buildTrackRow(t));

  // Column count, live cells and beat accents for the XY lane and both A/B
  // lanes at once (meter.md REQ-8/REQ-11) — one binding, so the three rows and
  // the ruler above them can never end up drawing different bars. Not
  // unsubscribed: the panel is built once and lives as long as the page does.
  bindLaneGrid(
    bus,
    'motion',
    () => [cells, ...trackRows.map((r) => r.cells)],
    () => [pads, ...trackRows.map((r) => r.pads)],
  );

  // Repaint the A/B lanes only while they are on screen (REQ-16b). A repaint
  // clears and rebuilds an SVG polyline plus up to 16 circles and re-levels 16
  // pads, *per lane* — and `arrangement.onChange` below fires every bar during
  // playback, so off-screen that is pure waste (runtime-performance.md REQ-4).
  // A repaint asked for while hidden is coalesced into one on reveal, so the
  // lanes are never stale. Same idiom as the XY graph's `graphDirty` further
  // down; the two are deliberately separate flags because they redraw different
  // DOM, but they share the one gate.
  let tracksDirty = false;
  const repaintTracks = (): void => { for (const r of trackRows) r.repaint(); };
  const repaintTracksIfShown = (): void => {
    if (!gate.shown) { tracksDirty = true; return; }
    repaintTracks();
  };
  gate.whenShown(() => {
    if (!tracksDirty) return;
    tracksDirty = false;
    repaintTracks();
  });

  patterns.onMotionTrackChange(repaintTracksIfShown);
  // Per lane (REQ-2): a track's staircase-vs-ramp follows its own param, so the
  // XY lane's STEP/SLIDE no longer redraws the tracks. Off-screen this coalesces
  // into the same reveal repaint as everything else — a per-lane redraw of a
  // panel nobody is looking at is the same waste as a per-bar one.
  for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
    bus.subscribe(`motion.t${t}.slide`, repaintTracksIfShown);
  }
  engine.arrangement.onChange(repaintTracksIfShown);

  // ---- Wiring ----
  const paintAll = (bank: readonly MotionStep[]): void => {
    for (let s = 0; s < ALL_CELLS; s++) pads[s]!.setStep(bank[s]!);
    redrawGraph();
    refreshAxes();
  };

  // Light the playing column across all three lanes (XY + A + B), not just the XY
  // pads — the tracks were added later (v4) and were never wired in (REQ-16).
  const highlighter = wirePlayhead(
    engine, 'motion', [pads, ...trackRows.map((r) => r.pads)], restOverlay, gate,
  );

  // Re-project the graph only when it is on screen. `arrangement.onChange` below
  // fires every bar during playback, and this is an SVG rebuild — off-screen
  // that is pure waste (runtime-performance.md REQ-4). A redraw requested while
  // hidden is coalesced into one on reveal, so the graph is never stale.
  let graphDirty = false;
  const redrawGraphIfShown = (): void => {
    if (!gate.shown) { graphDirty = true; return; }
    redrawGraph();
  };
  gate.whenShown(() => {
    if (!graphDirty) return;
    graphDirty = false;
    redrawGraph();
  });

  patterns.onMotionBankChange((bank) => {
    highlighter.clear();
    paintAll(bank);
  });
  patterns.onMotionChange((idx, step) => {
    pads[idx]?.setStep(step);
    redrawGraphIfShown();
  });
  xy.onChange(() => {
    refreshAxes();
    redrawGraphIfShown(); // a base reassignment can change which neighbours carry
  });
  // STEP/SLIDE changes the line's shape (staircase vs ramp) — re-project live.
  bus.subscribe('motion.slide', redrawGraphIfShown);
  // Chain edits (and each bar's advance) move which banks border this one.
  engine.arrangement.onChange(redrawGraphIfShown);
  // LEN / RATE / the meter change how many cells the curve is drawn over
  // (REQ-24b), so all three lanes re-project — the column count `bindLaneGrid`
  // sets above is only half of following the meter. Fires once on bind, which
  // is harmless: the initial draws below are idempotent.
  onLaneGridChange(bus, 'motion', () => {
    redrawGraphIfShown();
    repaintTracksIfShown();
  });

  redrawGraph();
  refreshAxes();
  return { el: root, gate };
}
