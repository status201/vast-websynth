import type { MotionStep } from '../../state/patterns';
import styles from '../styles/motion.module.css';

export interface MotionStepPadOpts {
  /** Beat-column accent (steps 0/4/8/12), like the drum grid's red columns. */
  beat?: boolean;
  /** A drag/click set the coordinate (both normalized 0..1, y up = more). */
  onSet: (x: number, y: number) => void;
  /** Double-click / double-tap cleared the step. */
  onClear: () => void;
}

/**
 * One motion-sequencer step: a mini XY pad (motion-sequencer.md REQ-8). A
 * single pointer gesture sets both coordinates — the dot sits at the literal
 * (x, y); double-click (or a fast double-tap) clears the anchor. Rendering is
 * driven by `setStep` so the panel's PatternStore subscriptions stay the one
 * source of truth (the pad never mutates state itself).
 */
export class MotionStepPad {
  readonly el: HTMLDivElement;
  private readonly dot: HTMLDivElement;
  private lastTapMs = 0;
  private dragging = false;

  constructor(private readonly opts: MotionStepPadOpts) {
    this.el = document.createElement('div');
    this.el.className = styles.pad! + (opts.beat ? ` ${styles.beat!}` : '');

    this.dot = document.createElement('div');
    this.dot.className = styles.dot!;
    this.el.appendChild(this.dot);

    // Own dragging flag + optional capture, like xy-pad.ts (jsdom-safe).
    this.el.addEventListener('pointerdown', (e) => {
      // Manual double-tap detection: dblclick is unreliable for touch, and we
      // want the clear to win over the set the first tap already applied.
      const now = Date.now();
      if (now - this.lastTapMs < 350) {
        this.lastTapMs = 0;
        this.dragging = false;
        this.opts.onClear();
        return;
      }
      this.lastTapMs = now;
      e.preventDefault();
      this.el.setPointerCapture?.(e.pointerId);
      this.dragging = true;
      this.apply(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (this.dragging) this.apply(e);
    });
    const end = (): void => { this.dragging = false; };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  private apply(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const x = clamp01((e.clientX - r.left) / r.width);
    const y = clamp01(1 - (e.clientY - r.top) / r.height); // up = more
    this.opts.onSet(x, y);
  }

  /** Repaint from the store's cell: lit state + dot position. */
  setStep(step: MotionStep): void {
    this.el.classList.toggle('on', step.on); // global state class (see CLAUDE.md CSS conventions)
    this.dot.style.left = `${step.x * 100}%`;
    this.dot.style.top = `${(1 - step.y) * 100}%`;
    this.el.title = step.on
      ? `x ${step.x.toFixed(2)} · y ${step.y.toFixed(2)} (double-click to clear)`
      : 'Drag to set an XY anchor';
  }

  setPlaying(p: boolean): void {
    this.el.classList.toggle('playing', p);
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
