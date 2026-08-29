// Interactive guided-tour engine: a dimmed spotlight overlay with a glowing
// cut-out around one control at a time plus a callout bubble. The spotlight is
// pointer-events:none so the *real* control underneath stays clickable — that
// is what lets steps like "press a key" / "press Play" be genuinely
// interactive. Only the callout (and its Back/Skip/Next buttons) is clickable.
import type { ParamBus } from '../../state/params';
import type { StudioApi } from '../studio-api';
import { createButton, setButtonLabel } from '../components/button';
import { clamp } from '../../utils/math';
import styles from '../styles/tour.module.css';
import { iconTextEl } from '../components/ui-icons';

export type Placement = 'auto' | 'top' | 'bottom' | 'left' | 'right';

/** How long the "✓ Nice" confirmation lingers before the note step advances. */
const NOTE_ADVANCE_MS = 2000;

/** Runtime hooks the steps need — injected so we never read DEV-only globals. */
export interface TourCtx {
  bus: ParamBus;
  engine: StudioApi;
  /** Toggle the transport via the header button (keeps the LED/label synced). */
  toggleTransport: () => void;
  /** Load a demo song by name (does NOT start the transport). */
  /** Load a demo song. Async — all but the built-in are fetched on click
   *  (song-mode.md REQ-12), so a step that acts on the loaded song must await. */
  applyDemo: (name: string) => Promise<void>;
  /** Resume the AudioContext (idempotent) — needed before the note step. */
  resumeAudio: () => Promise<void>;
  /** Force the (collapsible) FX section open. */
  expandFx: () => void;
}

export type TourTarget = string | (() => Element | null);

export interface TourStep {
  /** A `data-testid` string, a resolver, or undefined for a centered card. */
  target?: TourTarget;
  title: string;
  /** Light HTML (trusted, authored copy). */
  body: string;
  placement?: Placement;
  /** Run before the step renders — open a tab / expand FX / resume audio. */
  precondition?: (ctx: TourCtx) => void | Promise<void>;
  /** Run when the user advances (Next) — e.g. load a demo and start it. */
  action?: (ctx: TourCtx) => void | Promise<void>;
  /** 'note' auto-advances on the first incoming note; default 'next'. */
  advanceOn?: 'next' | 'note';
}

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface CalloutPos {
  left: number;
  top: number;
}

/**
 * Pure positioning helper (unit-tested). Places the callout near `rect`,
 * clamped inside the viewport. A null rect (no target) centers it.
 */
export function placeCallout(
  rect: RectLike | null,
  cw: number,
  ch: number,
  vw: number,
  vh: number,
  placement: Placement = 'auto',
): CalloutPos {
  const gap = 14;
  if (!rect) {
    return { left: clamp((vw - cw) / 2, 8, vw - cw - 8), top: clamp((vh - ch) / 2, 8, vh - ch - 8) };
  }

  let left = rect.left;
  let top: number;
  const below = rect.bottom + gap;
  const above = rect.top - gap - ch;

  switch (placement) {
    case 'top':
      top = above;
      break;
    case 'bottom':
      top = below;
      break;
    case 'left':
      left = rect.left - gap - cw;
      top = rect.top;
      break;
    case 'right':
      left = rect.right + gap;
      top = rect.top;
      break;
    default: // 'auto' — prefer below, flip above if it would overflow
      top = below + ch > vh ? above : below;
  }

  return { left: clamp(left, 8, vw - cw - 8), top: clamp(top, 8, vh - ch - 8) };
}

function resolveTarget(spec: TourTarget): HTMLElement | null {
  const el =
    typeof spec === 'string'
      ? document.querySelector<HTMLElement>(`[data-testid="${spec}"]`)
      : (spec() as HTMLElement | null);
  return el ?? null;
}

export class Tour {
  private idx = 0;
  private running = false;
  private rafQueued = false;
  private unsubNote: (() => void) | null = null;

  private overlay: HTMLElement | null = null;
  private spotlight!: HTMLElement;
  private callout!: HTMLElement;
  private titleEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private backBtn!: HTMLButtonElement;
  private skipBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;

  constructor(
    private readonly steps: TourStep[],
    private readonly ctx: TourCtx,
    private readonly onDone: (completed: boolean) => void,
  ) {}

  start(): void {
    if (this.running || this.steps.length === 0) return;
    this.running = true;
    this.buildDom();
    document.body.appendChild(this.overlay!);
    void this.overlay!.offsetWidth; // reflow so the fade-in runs from .hidden
    this.overlay!.classList.remove('hidden');
    window.addEventListener('resize', this.reflow, true);
    window.addEventListener('scroll', this.reflow, true);
    void this.show(0);
  }

  private buildDom(): void {
    const overlay = document.createElement('div');
    overlay.className = `${styles.overlay!} hidden`;
    overlay.dataset.testid = 'tour-overlay';

    const spotlight = document.createElement('div');
    spotlight.className = styles.spotlight!;
    overlay.appendChild(spotlight);

    const callout = document.createElement('div');
    callout.className = styles.callout!;
    callout.dataset.testid = 'tour-callout';

    const titleEl = document.createElement('div');
    titleEl.className = styles.calloutTitle!;
    const bodyEl = document.createElement('div');
    bodyEl.className = styles.calloutBody!;

    const footer = document.createElement('div');
    footer.className = styles.footer!;
    const progressEl = document.createElement('div');
    progressEl.className = styles.progress!;
    const actions = document.createElement('div');
    actions.className = styles.actions!;

    const backBtn = createButton({ label: 'Back', testId: 'tour-back', onClick: () => this.back() });
    const skipBtn = createButton({ label: 'Skip', testId: 'tour-skip', onClick: () => this.skip() });
    const nextBtn = createButton({ label: 'Next', testId: 'tour-next', onClick: () => void this.next() });

    actions.append(backBtn, skipBtn, nextBtn);
    footer.append(progressEl, actions);
    callout.append(titleEl, bodyEl, footer);
    overlay.appendChild(callout);

    this.overlay = overlay;
    this.spotlight = spotlight;
    this.callout = callout;
    this.titleEl = titleEl;
    this.bodyEl = bodyEl;
    this.progressEl = progressEl;
    this.backBtn = backBtn;
    this.skipBtn = skipBtn;
    this.nextBtn = nextBtn;
  }

  private async show(i: number): Promise<void> {
    this.clearNoteSub();
    if (i < 0) i = 0;
    this.idx = i;

    const step = this.steps[i];
    if (!step) {
      this.finish(true);
      return;
    }

    try {
      await step.precondition?.(this.ctx);
    } catch (err) {
      console.error('[tour] precondition failed', err);
    }
    if (!this.running) return; // skipped/finished while awaiting

    // Skip a step whose string target isn't in the DOM (e.g. hidden feature).
    if (typeof step.target === 'string' && !document.querySelector(`[data-testid="${step.target}"]`)) {
      void this.show(i + 1);
      return;
    }

    const target = step.target ? resolveTarget(step.target) : null;
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });

    this.render(step, i);
    this.scheduleReflow();

    if (step.advanceOn === 'note') {
      // Subscribe synchronously (before resuming audio) so a note fired in the
      // same tick is never missed. The tour only ever runs past the start gate —
      // tapped, or automatic where the browser never wanted a gesture
      // (audio-lifecycle.md REQ-20) — so the resume is only defensive and need
      // not block the listener.
      this.unsubNote = this.ctx.bus.onNote((on) => {
        if (!on) return;
        this.confirmNote();
        this.clearNoteSub();
        window.setTimeout(() => void this.next(), NOTE_ADVANCE_MS);
      });
      void this.ctx.resumeAudio().catch(() => {
        /* non-fatal — the user can still press Next */
      });
    }
  }

  private render(step: TourStep, i: number): void {
    this.titleEl.textContent = step.title;
    this.bodyEl.innerHTML = step.body;
    this.progressEl.textContent = `${i + 1} / ${this.steps.length}`;
    this.backBtn.style.display = i === 0 ? 'none' : '';
    const last = i === this.steps.length - 1;
    this.skipBtn.style.display = last ? 'none' : '';
    setButtonLabel(this.nextBtn, last ? 'Done' : 'Next');
    this.nextBtn.dataset.testid = last ? 'tour-done' : 'tour-next';
  }

  private confirmNote(): void {
    const c = document.createElement('div');
    c.className = styles.confirm!;
    c.appendChild(iconTextEl('check', "Nice — that's your synth talking."));
    this.bodyEl.appendChild(c);
  }

  private async next(): Promise<void> {
    const step = this.steps[this.idx];
    try {
      await step?.action?.(this.ctx);
    } catch (err) {
      console.error('[tour] action failed', err);
    }
    if (!this.running) return;
    await this.show(this.idx + 1);
  }

  private back(): void {
    void this.show(this.idx - 1);
  }

  private skip(): void {
    this.finish(false);
  }

  private finish(completed: boolean): void {
    if (!this.running) return;
    this.running = false;
    this.clearNoteSub();
    window.removeEventListener('resize', this.reflow, true);
    window.removeEventListener('scroll', this.reflow, true);
    const el = this.overlay;
    this.overlay = null;
    el?.classList.add('hidden');
    window.setTimeout(() => el?.remove(), 220);
    this.onDone(completed);
  }

  private clearNoteSub(): void {
    this.unsubNote?.();
    this.unsubNote = null;
  }

  private readonly reflow = (): void => this.scheduleReflow();

  private scheduleReflow(): void {
    if (this.rafQueued || !this.overlay) return;
    this.rafQueued = true;
    requestAnimationFrame(() => {
      this.rafQueued = false;
      const step = this.steps[this.idx];
      if (step && this.overlay) this.position(step);
    });
  }

  private position(step: TourStep): void {
    const target = step.target ? resolveTarget(step.target) : null;
    if (!target) {
      this.spotlight.classList.add(styles.centered!);
      Object.assign(this.spotlight.style, { left: '0px', top: '0px', width: '100vw', height: '100vh' });
    } else {
      this.spotlight.classList.remove(styles.centered!);
      const r = target.getBoundingClientRect();
      const pad = 6;
      Object.assign(this.spotlight.style, {
        left: `${r.left - pad}px`,
        top: `${r.top - pad}px`,
        width: `${r.width + pad * 2}px`,
        height: `${r.height + pad * 2}px`,
      });
    }

    const cr = this.callout.getBoundingClientRect();
    const rect = target ? target.getBoundingClientRect() : null;
    const p = placeCallout(rect, cr.width, cr.height, window.innerWidth, window.innerHeight, step.placement);
    Object.assign(this.callout.style, { left: `${p.left}px`, top: `${p.top}px` });
  }
}
