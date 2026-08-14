import styles from '../styles/resize-handle.module.css';

/**
 * A vertical resize handle — the ARIA window-splitter.
 *
 * Deliberately generic: it writes a CSS custom property on a target element and
 * reports commits. It knows nothing about what it is resizing, so the layout
 * rule lives in CSS (`grid-template-rows: var(--scope-h, 130px) …`) and the
 * default stays expressed there — an app with no stored value, or with storage
 * unavailable, renders exactly as it always did.
 *
 * Gesture inventory, precedent and the one documented ADR-014 deviation (the hit
 * box is 16px tall, not 44) are in `specs/features/scope.md` → Gesture inventory.
 * It is specced there rather than in a facility spec of its own because the scope
 * is its only consumer; a second one is what would earn it the promotion.
 */

/** ms — hand-rolled double-tap window (`dblclick` is unreliable on touch). */
const DOUBLE_TAP_MS = 350;

export interface ResizeHandleOptions {
  /** Element the custom property is written on. */
  target: HTMLElement;
  /** Custom property name, e.g. `--scope-h`. */
  cssVar: string;
  /** px, inclusive. */
  min: number;
  /** px, inclusive. */
  max: number;
  /** Starting size — the caller is responsible for having clamped it. */
  initial: number;
  /** What double-tap and `Home` reset to. */
  defaultValue: number;
  /** px per arrow-key press. */
  step: number;
  /** Fired on release / key commit — never per pointer move. */
  onCommit(px: number): void;
  testId: string;
  /** `aria-label`; the `title` states the gesture. */
  label: string;
  title: string;
  /**
   * Consumer-owned positioning class. The component styles appearance and
   * interaction; only the consumer knows where the handle goes and what it has
   * to sit clear of, so position and size live in the consumer's stylesheet
   * (the split `.scopeToggle` already makes against `switch.module.css`).
   */
  className?: string;
}

export class ResizeHandle {
  readonly el: HTMLElement;

  private current: number;
  private dragging = false;
  private moved = false;
  private startY = 0;
  private startValue = 0;
  /** -Infinity, not 0: at 0 the first press within 350ms of page load would
   *  read as a double-tap and reset the height out from under the user. */
  private lastTap = Number.NEGATIVE_INFINITY;
  /** rAF-coalesced write (REQ-21): a fast drag costs one style write per frame. */
  private pendingValue: number | null = null;
  private rafId = 0;

  constructor(private readonly opts: ResizeHandleOptions) {
    this.current = this.clamp(opts.initial);

    this.el = document.createElement('div');
    this.el.className = opts.className ? `${styles.root!} ${opts.className}` : styles.root!;
    this.el.dataset.testid = opts.testId;
    this.el.title = opts.title;
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'separator');
    this.el.setAttribute('aria-orientation', 'horizontal');
    this.el.setAttribute('aria-label', opts.label);
    this.el.setAttribute('aria-valuemin', String(opts.min));
    this.el.setAttribute('aria-valuemax', String(opts.max));

    const grip = document.createElement('div');
    grip.className = styles.grip!;
    this.el.appendChild(grip);

    // Write the property immediately so the target and aria agree from frame one.
    this.apply(this.current);

    this.el.addEventListener('pointerdown', this.onPointerDown);
    this.el.addEventListener('keydown', this.onKeyDown);
  }

  get value(): number {
    return this.current;
  }

  /** Set (clamped) and write through immediately — used by tests and callers. */
  set(px: number): void {
    this.cancelFrame();
    this.apply(this.clamp(px));
  }

  private clamp(px: number): number {
    if (!Number.isFinite(px)) return this.opts.defaultValue;
    return Math.min(this.opts.max, Math.max(this.opts.min, Math.round(px)));
  }

  /** The only place the custom property and `aria-valuenow` are written. */
  private apply(px: number): void {
    this.current = px;
    this.opts.target.style.setProperty(this.opts.cssVar, `${px}px`);
    this.el.setAttribute('aria-valuenow', String(px));
  }

  /** Coalesce to one write per frame; the drag stays pixel-accurate regardless. */
  private schedule(px: number): void {
    this.pendingValue = px;
    if (this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      const v = this.pendingValue;
      this.pendingValue = null;
      if (v !== null) this.apply(v);
    });
  }

  private cancelFrame(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.pendingValue = null;
  }

  /** Flush a scheduled write, so a release always lands on the final value. */
  private flush(): void {
    const v = this.pendingValue;
    this.cancelFrame();
    if (v !== null) this.apply(v);
  }

  private commit(): void {
    this.opts.onCommit(this.current);
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Stops the page scrolling out from under a touch drag, and stops the
    // browser starting a text selection on a mouse drag.
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId); // jsdom has none

    const now = performance.now();
    if (now - this.lastTap < DOUBLE_TAP_MS) {
      this.lastTap = Number.NEGATIVE_INFINITY; // a third tap is not a second one

      this.set(this.opts.defaultValue);
      this.commit();
      return;
    }
    this.lastTap = now;

    this.dragging = true;
    this.moved = false;
    // Measure once per gesture (recipes/add-a-ui-component.md) — the stroke is
    // pure arithmetic from here, no layout reads.
    this.startY = e.clientY;
    this.startValue = this.current;
    this.el.classList.add('dragging');
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    // Up is taller: the handle is on the top edge, so it follows the pointer.
    const next = this.clamp(this.startValue + (this.startY - e.clientY));
    if (next === this.current && !this.moved) return;
    this.moved = true;
    this.schedule(next);
  };

  private onPointerUp = (_: PointerEvent): void => {
    this.detachDragListeners();
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('dragging');
    this.flush();
    // A press that never moved is not a resize — leave the height, write nothing.
    if (this.moved) this.commit();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    let next: number;
    if (e.key === 'ArrowUp') next = this.current + this.opts.step;
    else if (e.key === 'ArrowDown') next = this.current - this.opts.step;
    else if (e.key === 'Home') next = this.opts.defaultValue;
    else return;
    e.preventDefault();
    const clamped = this.clamp(next);
    if (clamped === this.current) return;
    this.set(clamped);
    this.commit();
  };

  private detachDragListeners(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  destroy(): void {
    this.detachDragListeners();
    this.cancelFrame();
    this.el.removeEventListener('pointerdown', this.onPointerDown);
    this.el.removeEventListener('keydown', this.onKeyDown);
  }
}
