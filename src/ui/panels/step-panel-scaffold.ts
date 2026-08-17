import type { StudioApi } from '../studio-api';
import type { ParamBus } from '../../state/params';
import type { UiBridge } from '../ui-bridge';
import type { Arrangement, ChainLane } from '../../audio/transport/arrangement';
import { BankBar } from '../components/bank-bar';
import { Switch } from '../components/switch';
import { createChainToggle } from '../components/chain-toggle';
import layout from '../styles/layout.module.css';
import { PlayheadHighlighter, type PlayheadCell } from '../components/playhead-highlighter';
import { buildPlayheadRuler, type PlayheadRuler } from '../components/playhead-ruler';
import { buildRestOverlay, type RestLane, type RestOverlay } from '../components/rest-overlay';
import { StepButton } from '../components/step-button';
import { createClearMenu } from '../components/clear-menu';
import { showToast } from '../components/toast';
import type { PatternUndo } from '../../state/pattern-undo';
import { BANK_LABELS, SAMPLER_SLOT_LABELS } from '../../state/patterns';
import { GRID_CELLS, LANE_RATE_LABELS, meterLabel, ticksPerCell } from '../../state/meter';
import { Dropdown } from '../components/dropdown';
import { laneGrid, onLaneGridChange } from '../lane-grid';
import dropdownStyles from '../styles/dropdown.module.css';
import { ListenerSet } from '../../utils/listeners';

/**
 * `<m>.len` as labels: index 0 is the `LEN_FOLLOW` sentinel, and it reads as
 * **BAR** rather than "0" or "follow" — the value is a bar's worth of steps,
 * and a numeral there would look like a length of zero.
 */
const LEN_LABELS: string[] = ['BAR', ...Array.from({ length: GRID_CELLS }, (_, i) => String(i + 1))];


/**
 * The chrome every machine tab (seq / drum / sampler / motion) wraps around its
 * own grid: a bank bar, a rest overlay over the grid, and a playhead that only
 * lights when the edit bank *is* the playing bank.
 *
 * These are composable helpers rather than one `buildStepPanel()` — the panel
 * bodies genuinely differ (note labels, tuning strips, slot loaders, an SVG
 * graph), so a rigid template would fight all four. What is shared is the
 * *lane plumbing*: PatternStore, Arrangement and the machines all expose the
 * same accessor family per lane, so one switch (`laneHooks`) covers it and each
 * helper below reads from that.
 *
 * Every `data-testid` the panels minted before is preserved — `testidPrefix`
 * is the lane name, which is what the four panels already passed.
 */
export type StepLane = RestLane;

interface LaneHooks {
  getEdit(): number;
  setEdit(i: number): void;
  copy(from: number, to: number): void;
  onEditChange(fn: () => void): () => void;
  getPlay(): number;
  onPlayChange(fn: () => void): () => void;
  /** True while the lane's current chain slot is a REST (an empty bar). */
  getResting(): boolean;
  hasContent(i: number): boolean;
  onContentChange(fn: () => void): () => void;
  onStep(fn: (idx: number) => void): () => void;
  /** Clear the edit bank; true when something was actually cleared (REQ-6). */
  clearBank(): boolean;
}

function laneHooks(engine: StudioApi, lane: StepLane): LaneHooks {
  const p = engine.patterns;
  const a = engine.arrangement;
  const common = {
    onEditChange: (fn: () => void) => p.onEditBankChange(fn),
    onPlayChange: (fn: () => void) => a.onChange(fn),
  };
  switch (lane) {
    case 'seq':
      return {
        ...common,
        getEdit: () => p.seqEditBank,
        setEdit: (i) => p.setSeqEditBank(i),
        copy: (f, t) => p.copySeqBank(f, t),
        getPlay: () => a.seqPlayBank,
        getResting: () => a.seqResting,
        hasContent: (i) => p.seqBanks[i]!.some((track) => track.some((s) => s.on)),
        onContentChange: (fn) => p.onSeqChange(fn),
        onStep: (fn) => engine.seq.onStep(fn),
        clearBank: () => p.clearSeqBank(),
      };
    case 'drum':
      return {
        ...common,
        getEdit: () => p.drumEditBank,
        setEdit: (i) => p.setDrumEditBank(i),
        copy: (f, t) => p.copyDrumBank(f, t),
        getPlay: () => a.drumPlayBank,
        getResting: () => a.drumResting,
        hasContent: (i) => p.drumBanks[i]!.some((tr) => tr.some((c) => c.on)),
        onContentChange: (fn) => p.onDrumChange(fn),
        onStep: (fn) => engine.drums.onStep(fn),
        clearBank: () => p.clearDrumBank(),
      };
    case 'sampler':
      return {
        ...common,
        getEdit: () => p.samplerEditBank,
        setEdit: (i) => p.setSamplerEditBank(i),
        copy: (f, t) => p.copySamplerBank(f, t),
        getPlay: () => a.samplerPlayBank,
        getResting: () => a.samplerResting,
        hasContent: (i) => p.samplerBanks[i]!.some((sl) => sl.some((c) => c.on)),
        onContentChange: (fn) => p.onSamplerChange(fn),
        onStep: (fn) => engine.sampler.onStep(fn),
        clearBank: () => p.clearSamplerBank(),
      };
    case 'motion':
      return {
        ...common,
        getEdit: () => p.motionEditBank,
        setEdit: (i) => p.setMotionEditBank(i),
        copy: (f, t) => p.copyMotionBank(f, t),
        getPlay: () => a.motionPlayBank,
        getResting: () => a.motionResting,
        // Motion stores THREE lanes per bank (XY anchors + tracks A/B), so a bank
        // whose tracks are full but whose XY lane is empty is still a filled bank
        // (banks.md REQ-6) — the same rule the panel's Clear ▾ list uses.
        hasContent: (i) => p.motionBanks[i]!.some((s) => s.on)
          || p.motionTracks(i).some((t) => t.steps.some((s) => s.on)),
        // Both streams can flip that answer, so both must repaint the bar.
        onContentChange: (fn) => {
          const offXy = p.onMotionChange(fn);
          const offTracks = p.onMotionTrackChange(fn);
          return () => { offXy(); offTracks(); };
        },
        onStep: (fn) => engine.motion.onStep(fn),
        clearBank: () => p.clearMotionBank(),
      };
  }
}

/** The lane's A/B/C/D bank bar, testids namespaced by the lane name. */
export function bankBarFor(engine: StudioApi, lane: StepLane): BankBar {
  const h = laneHooks(engine, lane);
  return new BankBar({
    getEdit: h.getEdit,
    setEdit: h.setEdit,
    copy: h.copy,
    onEditChange: h.onEditChange,
    getPlay: h.getPlay,
    onPlayChange: h.onPlayChange,
    resting: h.getResting,
    hasContent: h.hasContent,
    onContentChange: h.onContentChange,
    testidPrefix: lane,
  });
}

/**
 * `position: relative` wrapper holding the grid plus the rest overlay that
 * covers it while the arrangement plays a rest bar (arrangement-rest.md REQ-6).
 * `content` is appended in order *before* the overlay, so the overlay always
 * stays on top (motion passes `[cells, graphSvg]`).
 */
export function wrapGridWithRestOverlay(
  engine: StudioApi,
  lane: StepLane,
  bankBar: BankBar,
  ...content: Element[]
): { el: HTMLElement; restOverlay: RestOverlay } {
  const el = document.createElement('div');
  el.style.position = 'relative';
  for (const c of content) el.appendChild(c);
  const restOverlay = buildRestOverlay(engine, lane, { following: () => bankBar.following });
  el.appendChild(restOverlay.el);
  bankBar.onFollowChange(() => restOverlay.refresh());
  return { el, restOverlay };
}

/**
 * Whether a machine panel's content is actually on screen.
 *
 * `TabContainer` hides an inactive panel with a class, so all four panels stay
 * live and subscribed: without this gate every one of them repaints its playhead
 * on every 16th — ~50 class writes a tick against DOM nobody can see — and the
 * Motion panel re-projects its SVG graph every bar (runtime-performance.md
 * REQ-4).
 *
 * Panels are built **before** the `TabContainer` exists, so a gate starts
 * `shown` and is corrected by the first `onViewChange`; a panel can never be
 * stuck dark. `whenShown` is how deferred work catches up on reveal — the point
 * of the gate is to skip work, not to show stale state.
 */
export class VisibilityGate {
  private visible = true;
  private readonly showListeners = new ListenerSet();

  get shown(): boolean { return this.visible; }

  set(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.showListeners.emit();
  }

  /** Run `fn` whenever the panel becomes visible again. Returns a disposer. */
  whenShown(fn: () => void): () => void {
    return this.showListeners.add(fn);
  }
}

/**
 * Drive the playing-step highlight from the machine's `onStep`. The highlight
 * only shows while the edit bank *is* the playing bank (so editing bank C while
 * B plays doesn't chase a phantom playhead) *and* the lane is not resting (a
 * rest bar plays no bank, so the highlight is hidden rather than sweeping under
 * the rest overlay — arrangement-rest.md REQ-4). The rest overlay is refreshed
 * on the same tick so bar boundaries update promptly.
 *
 * While `gate` reports hidden the tick does nothing at all; revealing the panel
 * replays the current step immediately, so it never opens on a stale column or
 * a missing rest overlay.
 */
export function wirePlayhead(
  engine: StudioApi,
  lane: StepLane,
  rows: readonly (readonly PlayheadCell[])[],
  restOverlay: RestOverlay,
  gate?: VisibilityGate,
): PlayheadHighlighter {
  const h = laneHooks(engine, lane);
  const highlighter = new PlayheadHighlighter(rows);
  let lastStep = -1;

  const paint = (idx: number): void => {
    highlighter.update(idx, h.getEdit() === h.getPlay() && !h.getResting());
    restOverlay.refresh();
  };

  h.onStep((idx) => {
    lastStep = idx;
    if (gate && !gate.shown) return;
    paint(idx);
  });
  gate?.whenShown(() => { if (lastStep >= 0) paint(lastStep); });

  return highlighter;
}

/**
 * The lane's transport-position ruler (transport-position.md REQ-9), testids
 * namespaced by lane exactly like `bankBarFor`/`clearMenuFor`.
 *
 * The panel places the two pieces itself — `barEl` in its row-label slot,
 * `cellsEl` wearing the panel's own steps-grid class — because the four grids
 * have different label widths and column gaps, and reusing each panel's real
 * grid class is what keeps the ticks aligned with the steps beneath them.
 */
/** Per-lane chain setters — `Arrangement` exposes one method per lane, not a
 *  generic one, so the switch lives here beside the rest of the lane plumbing. */
const SET_CHAIN: Record<StepLane, (a: Arrangement, steps: number[], on: boolean) => void> = {
  seq: (a, s, on) => a.setSeqChain(s, on),
  drum: (a, s, on) => a.setDrumChain(s, on),
  sampler: (a, s, on) => a.setSamplerChain(s, on),
  motion: (a, s, on) => a.setMotionChain(s, on),
};

export interface LaneControls {
  readonly el: HTMLElement;
  destroy(): void;
}

/**
 * The **Chain / Mute / Solo** cluster for a machine header (machine-status.md
 * REQ-8) — the same three controls the Song tab's lane card carries, built from
 * the same `createChainToggle` and `Switch` so behaviour, state and looks cannot
 * drift between the two surfaces.
 *
 * Motion gets no Solo, exactly as on the Song tab: it is not an audio lane, so
 * there is nothing to solo (`audibleLanes` has no motion entry).
 */
export function laneControlsFor(
  bus: ParamBus,
  engine: StudioApi,
  lane: StepLane,
  bridge: UiBridge,
): LaneControls {
  const el = document.createElement('div');
  el.className = layout.laneControls!;

  const chain = createChainToggle({
    getLane: () => engine.arrangement[lane] as ChainLane,
    setChain: (steps, on) => SET_CHAIN[lane](engine.arrangement, steps, on),
    cuePlay: () => bridge.cuePlay(),
    testId: `machine-${lane}-chain`,
  });
  el.appendChild(chain.el);

  // Distinct testids: the same params are already switchable from the Song tab,
  // and two elements sharing a testid break Playwright strict mode. The two
  // instances stay in lock-step because each subscribes to the bus.
  const switches = [new Switch(bus, `${lane}.mute`, 'Mute', `machine-${lane}-mute`)];
  if (lane !== 'motion') {
    switches.push(new Switch(bus, `${lane}.solo`, 'Solo', `machine-${lane}-solo`));
  }
  for (const s of switches) el.appendChild(s.el);

  // A chain's enabled flag is Arrangement state, not a bus param, so the LED has
  // to be refreshed from the arrangement's own change signal.
  const off = engine.arrangement.onChange(() => chain.refresh());

  return {
    el,
    destroy(): void {
      off();
      for (const s of switches) s.destroy();
    },
  };
}

/**
 * The **LEN / RATE** pair for a machine header (meter.md REQ-10/REQ-14) — how
 * many cells this lane loops over and how long each one lasts.
 *
 * Built here rather than per panel so all four machines get the identical
 * control, and so "follow the bar" reads the same everywhere: LEN's `0` renders
 * as **BAR**, which is what the default means and what makes the meter picker
 * the only control most users ever touch.
 *
 * A hint line says what the pair currently amounts to, because two dropdowns
 * that interact are exactly the case ADR-014 says not to make the user simulate
 * in their head: `12 × 1/16 = 3/4` tells them the lane is in meter, and
 * `12 × 1/16 vs 4/4` tells them it is deliberately not.
 */
export function laneMeterControlsFor(bus: ParamBus, lane: StepLane): LaneControls {
  const el = document.createElement('div');
  el.className = layout.laneMeter!;
  // The cluster carries its own id: its `title` is where the in-meter reading
  // lives, and counting DOM levels up from a child is the kind of selector that
  // breaks the moment a wrapper is added (testids.md REQ-3).
  el.dataset.testid = `machine-${lane}-grid`;

  const len = new Dropdown(LEN_LABELS);
  len.el.classList.add(dropdownStyles.compact!, dropdownStyles.narrow!);
  len.el.dataset.testid = `machine-${lane}-len`;
  len.el.title = 'LEN — steps this machine loops over. BAR follows the time signature.';
  len.onChange((v) => bus.set(`${lane}.len`, LEN_LABELS.indexOf(v)));

  const rate = new Dropdown([...LANE_RATE_LABELS]);
  rate.el.classList.add(dropdownStyles.compact!, dropdownStyles.narrow!);
  rate.el.dataset.testid = `machine-${lane}-rate`;
  rate.el.title = 'RATE — how long one step lasts.';
  rate.onChange((v) => bus.set(`${lane}.rate`, LANE_RATE_LABELS.indexOf(v)));

  const hint = document.createElement('span');
  hint.className = layout.laneMeterHint!;
  hint.dataset.testid = `machine-${lane}-meter-hint`;

  // One caption for the pair: this is the machine's step GRID, and two captions
  // cost width the header does not have (see layout.module.css).
  el.append(
    labelled('GRID', sized(len.el, layout.laneMeterLen!)),
    sized(rate.el, layout.laneMeterRate!),
    hint,
  );

  const off = onLaneGridChange(bus, lane, () => {
    const grid = laneGrid(bus, lane);
    len.setValue(LEN_LABELS[Math.round(bus.get(`${lane}.len`))] ?? LEN_LABELS[0]!);
    rate.setValue(LANE_RATE_LABELS[grid.rate] ?? '1/16');
    const laneTicks = grid.cells * ticksPerCell(grid.rate);
    const meter = meterLabel(bus.get('transport.beats'), bus.get('transport.beatUnit'));
    const inMeter = laneTicks === grid.bar;
    // Shown only when the lane is OFF the bar. In meter the two dropdowns
    // already say everything ("BAR" / "1/16"), and this is a machine header
    // that has to survive `responsive-machine-header.md`'s one-row budget at
    // 1440px — a permanent third element ate it. Off the bar the words earn
    // their width: `12 steps vs 4/4 — polyrhythm` is the difference between a
    // deliberate setting and something that looks broken.
    hint.textContent = inMeter ? '' : `${grid.cells} steps vs ${meter} — polyrhythm`;
    hint.hidden = inMeter;
    // The in-meter reading moves to the cluster's tooltip, so it is still
    // reachable without costing a pixel of the header.
    el.title = inMeter
      ? `${grid.cells} steps of ${LANE_RATE_LABELS[grid.rate]} = one ${meter} bar`
      : `${grid.cells} steps of ${LANE_RATE_LABELS[grid.rate]} against a ${meter} bar`;
  });

  return {
    el,
    destroy(): void { off(); len.destroy(); rate.destroy(); },
  };
}

/** A fixed-width box for a `.compact` Dropdown to fill (see layout.module.css). */
function sized(control: HTMLElement, cls: string): HTMLElement {
  const box = document.createElement('div');
  box.className = cls;
  box.appendChild(control);
  return box;
}

/** A caption beside a compact control, matching the knob captions near it. */
function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = layout.laneMeterField!;
  const cap = document.createElement('span');
  cap.className = layout.laneMeterLabel!;
  cap.textContent = text;
  wrap.append(cap, control);
  return wrap;
}

export function playheadRulerFor(
  engine: StudioApi,
  bus: ParamBus,
  lane: StepLane,
  gate?: VisibilityGate,
): PlayheadRuler {
  // The ruler's readout names the bank while nothing is chained
  // (transport-position.md REQ-15). Hand it the SAME accessors `bankBarFor` uses,
  // so the letter can never disagree with the bank bar sitting beside it.
  const h = laneHooks(engine, lane);
  return buildPlayheadRuler(engine, bus, lane, gate, {
    getBank: h.getEdit,
    onBankChange: h.onEditChange,
  });
}

/**
 * What every machine tab returns, so `app.ts` can route keyboard actions to the
 * grid that is actually on screen without knowing anything else about the panel
 * (step-grid-editing.md REQ-5). The seq panel extends it with `disarmStepInput`.
 */
export interface MachinePanel {
  readonly el: HTMLElement;
  /** Switch the selected step off (Delete/Backspace). Non-destructive: the
   *  step keeps its note/velocity/gate, per REQ-2. */
  clearSelectedStep(): void;
  /** Driven by `TabContainer.onViewChange`; see {@link VisibilityGate}. */
  readonly gate: VisibilityGate;
}

/** What the Motion panel returns — no selection cursor, so no clearSelectedStep. */
export interface GatedPanel {
  readonly el: HTMLElement;
  readonly gate: VisibilityGate;
}

/**
 * One row-scoped clear a panel offers; `clear` reports whether it did anything.
 *
 * A row is normally exactly its steps, and the toast's Undo is the lane's pattern
 * undo. A row that clears **more** than steps sets `undo` and owns reversal
 * outright — it *replaces* the default rather than running beside it, because the
 * pattern stack carries steps only (step-grid-editing.md REQ-7). The sampler's is
 * the one such row: its item is labelled with the slot's filename, so it ejects
 * the sample too (sampler.md REQ-9).
 */
export interface ClearRow {
  label: string;
  /**
   * False when the row holds nothing this item would remove — `clearMenuFor`
   * then drops it, because an item that would do nothing is a dead item
   * (step-grid-editing.md REQ-6, ADR-014 law 1). Panels return every row they
   * have and answer this per row; the filter is central so a fifth machine
   * inherits the rule rather than having to remember it.
   *
   * "Content" must match what the item destroys — which is why the sampler
   * counts a loaded sample, not just steps (sampler.md REQ-9).
   */
  hasContent: boolean;
  clear(): boolean;
  undo?: () => void;
}

/**
 * The sampler's row-scoped clear (sampler.md REQ-9). The menu item says a
 * *filename*, so it has to remove the file: the slot's steps in the edit bank,
 * plus the name and the buffer behind it. Ejecting via `setBuffer` is what lets
 * sample-persistence drop the stored clip without this caller knowing.
 *
 * `Clear bank` deliberately does none of it — `sampleNames` is per-slot and shared
 * by all four banks, so a bank-scoped eject would silently un-sound the same slots
 * in the banks the user is not looking at.
 *
 * Lives here rather than inside the panel closure so a unit test can reach it, and
 * because the rest of the Clear-menu wiring it feeds is already here. The name and
 * buffer are read when the MENU OPENS — that read is also the label — so `undo`
 * can hand them straight back; the `AudioBuffer` is still referenced by this
 * closure, so nothing is re-decoded.
 */
export function samplerSlotClearRow(engine: StudioApi, undo: PatternUndo, slot: number): ClearRow {
  const name = engine.patterns.sampleNames[slot] ?? null;
  const buf = engine.sampler.buffers[slot] ?? null;
  let steps = false;
  return {
    label: name ?? SAMPLER_SLOT_LABELS[slot] ?? `S${slot + 1}`,
    // A named slot is content even with an empty grid — the item removes the
    // name, so offering it is the whole point (REQ-9). Filtering on steps alone
    // is exactly the bug this row exists to fix.
    hasContent: (engine.patterns.sampler[slot]?.some((c) => c.on) ?? false)
      || name !== null || buf !== null,
    clear: () => {
      steps = engine.patterns.clearSamplerSlot(slot);
      // Buffer first, then the name: the meta event is what repaints the row
      // label, and it reads `buffers[slot]` for the .needs-reload hint.
      if (buf) engine.sampler.setBuffer(slot, null);
      if (name !== null) engine.patterns.setSampleName(slot, null);
      return steps || name !== null || buf !== null;
    },
    undo: () => {
      // Only when the store actually pushed one. An unconditional call would pop
      // the user's PREVIOUS sampler edit off the lane's stack whenever the slot
      // held no steps — silent data loss dressed up as an Undo.
      if (steps) undo.undo('sampler');
      if (buf) engine.sampler.setBuffer(slot, buf);
      if (name !== null) engine.patterns.setSampleName(slot, name);
    },
  };
}

/**
 * The lane's `Clear ▾` header control, wired to the store's bulk-clear entry
 * points (step-grid-editing.md REQ-6/REQ-8). Each clear is ONE PatternStore
 * mutation, so the toast's Undo — and the machine's Undo button, and Ctrl+Z —
 * all reverse the whole thing in a single press (REQ-7).
 *
 * `rows` is resolved every time the menu opens. A machine with a selection
 * cursor returns its one selected row; Motion has no cursor, so it returns
 * every lane that currently holds steps.
 */
export function clearMenuFor(
  engine: StudioApi,
  lane: StepLane,
  undo: PatternUndo,
  rows?: () => ClearRow[],
): HTMLElement {
  const h = laneHooks(engine, lane);
  const bankLabel = (): string => BANK_LABELS[h.getEdit()] ?? String(h.getEdit() + 1);

  // Nothing cleared ⇒ no toast and no undo entry: an "Undo" that does nothing
  // is worse than no toast at all. `onUndo` overrides the lane's pattern undo for
  // a row that cleared more than steps and therefore reverses itself (REQ-7).
  const report = (what: string, changed: boolean, onUndo?: () => void): void => {
    if (!changed) return;
    showToast({
      message: `Cleared ${what}`,
      actionLabel: 'Undo',
      onAction: onUndo ?? (() => undo.undo(lane)),
      testId: `clear-toast-${lane}`,
    });
  };

  return createClearMenu({
    lane,
    bankLabel,
    onClearBank: () => report(`bank ${bankLabel()}`, h.clearBank()),
    ...(rows
      ? {
        // The one place the no-dead-item rule lives (REQ-6): panels hand over
        // every row they have, and an empty one never reaches the menu.
        rows: () => rows().filter((r) => r.hasContent).map((r) => ({
          label: r.label,
          run: () => report(r.label, r.clear(), r.undo),
        })),
      }
      : {}),
  });
}

/**
 * The 2-D selection cursor the drum and sampler grids share: exactly one cell
 * carries `StepButton.selectedClass`, and moving it runs the panel's own
 * refresh work (`onMove`).
 */
export class GridCursor {
  private row = 0;
  private col = 0;

  constructor(
    private readonly cells: readonly (readonly StepButton[])[],
    private readonly onMove: () => void,
  ) {}

  get selRow(): number { return this.row; }
  get selCol(): number { return this.col; }

  set(row: number, col: number): void {
    this.cells[this.row]?.[this.col]?.el.classList.remove(StepButton.selectedClass);
    this.row = row;
    this.col = col;
    this.cells[row]?.[col]?.el.classList.add(StepButton.selectedClass);
    this.onMove();
  }
}
