import type { StudioApi } from '../studio-api';
import { BankBar } from '../components/bank-bar';
import { PlayheadHighlighter, type PlayheadCell } from '../components/playhead-highlighter';
import { buildRestOverlay, type RestLane, type RestOverlay } from '../components/rest-overlay';
import { StepButton } from '../components/step-button';
import { createClearMenu } from '../components/clear-menu';
import { showToast } from '../components/toast';
import type { PatternUndo } from '../../state/pattern-undo';
import { BANK_LABELS } from '../../state/patterns';

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
        hasContent: (i) => p.motionBanks[i]!.some((s) => s.on),
        onContentChange: (fn) => p.onMotionChange(fn),
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
 * Drive the playing-step highlight from the machine's `onStep`. The highlight
 * only shows while the edit bank *is* the playing bank, so editing bank C
 * while B plays doesn't chase a phantom playhead; the rest overlay is
 * refreshed on the same tick so bar boundaries update promptly.
 */
export function wirePlayhead(
  engine: StudioApi,
  lane: StepLane,
  rows: readonly (readonly PlayheadCell[])[],
  restOverlay: RestOverlay,
): PlayheadHighlighter {
  const h = laneHooks(engine, lane);
  const highlighter = new PlayheadHighlighter(rows);
  h.onStep((idx) => {
    highlighter.update(idx, h.getEdit() === h.getPlay());
    restOverlay.refresh();
  });
  return highlighter;
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
}

/**
 * The lane's `Clear ▾` header control, wired to the store's bulk-clear entry
 * points (step-grid-editing.md REQ-6/REQ-8). Each clear is ONE PatternStore
 * mutation, so the toast's Undo — and the machine's Undo button, and Ctrl+Z —
 * all reverse the whole thing in a single press (REQ-7).
 *
 * `row` is the row-scoped item; single-row grids (seq, motion) omit it and get
 * a bank-only menu.
 */
export function clearMenuFor(
  engine: StudioApi,
  lane: StepLane,
  undo: PatternUndo,
  row?: { label(): string; clear(): boolean },
): HTMLElement {
  const h = laneHooks(engine, lane);
  const bankLabel = (): string => BANK_LABELS[h.getEdit()] ?? String(h.getEdit() + 1);

  // Nothing cleared ⇒ no toast and no undo entry: an "Undo" that does nothing
  // is worse than no toast at all.
  const report = (what: string, changed: boolean): void => {
    if (!changed) return;
    showToast({
      message: `Cleared ${what}`,
      actionLabel: 'Undo',
      onAction: () => undo.undo(lane),
      testId: `clear-toast-${lane}`,
    });
  };

  return createClearMenu({
    lane,
    bankLabel,
    onClearBank: () => report(`bank ${bankLabel()}`, h.clearBank()),
    ...(row
      ? { rowLabel: row.label, onClearRow: () => report(row.label(), row.clear()) }
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
