import styles from '../styles/resize-handle.module.css';
import { LONG_DOUBLE_TAP_MS as DOUBLE_TAP_MS } from './gesture-timing';
import { UI_ICONS } from './ui-icons';

/**
 * The shared resize grip — the ARIA window-splitter (specs/features/resize-handle.md).
 *
 * Deliberately generic: it writes a CSS custom property on a target element and
 * reports commits. It knows nothing about what it is resizing, so the layout
 * rule lives in the consumer's CSS (`min-height: var(--scope-h, 130px)` on the
 * scope row) and the default stays expressed there — an app with no stored
 * value, or with storage unavailable, renders exactly as it always did
 * (REQ-a-handle-writes-one-custom-property).
 *
 * Consumers: the scope's top edge (scope.md, the `up` default) and the
 * resizable floating windows (floating-window.md REQ-a-window-may-be-resizable),
 * which add a direction, live bounds and an automatic size.
 */

export type ResizeDirection = 'up' | 'right' | 'down-right';

export interface ResizeHandleOptions {
  /** Element the custom property is written on. */
  target: HTMLElement;
  /** Custom property name, e.g. `--scope-h`. */
  cssVar: string;
  /** px, inclusive — the static bounds, used when there is no `bounds()`. */
  min: number;
  /** px, inclusive. */
  max: number;
  /** Starting size, or `null` to leave the property unset so the consumer's CSS
   *  default renders (REQ-a-handle-may-start-automatic). */
  initial: number | null;
  /** What double-tap and `Home` reset to when there is no `onReset`. */
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
  /** The edge the grip sits on — which way growth follows the pointer
   *  (REQ-a-handle-has-a-direction). Default `'up'`. */
  direction?: ResizeDirection;
  /** The live size while the property is unset; read once per gesture. */
  measure?(): number;
  /** Live bounds, read per gesture, per key and on `refresh()`
   *  (REQ-a-handle-may-have-live-bounds). Take precedence over `min`/`max`. */
  bounds?(): { min: number; max: number };
  /** Double-tap / `Home` clear the property back to the CSS default and call
   *  this instead of committing (REQ-a-handle-may-reset-to-automatic). */
  onReset?(): void;
}

/** Everything a direction decides (REQ-a-handle-has-a-direction), in one row,
 *  so a new direction is a new row rather than a branch in four places. */
interface DirectionSpec {
  /** Growth for a pointer delta. */
  grow(dx: number, dy: number): number;
  /** Arrow keys: `+1` grows, `-1` shrinks. */
  keys: Readonly<Record<string, 1 | -1>>;
  /** The separator's orientation is across the drag: a top edge is horizontal. */
  orientation: 'horizontal' | 'vertical';
  /** The module class carrying the cursor and the grip's shape, if not the default. */
  styleClass?: string;
  /** Drawn grip, when a pill is not the convention. */
  glyph?: string;
}

const DIRECTIONS: Record<ResizeDirection, DirectionSpec> = {
  // The scope's top edge: up is taller.
  up: { grow: (_dx, dy) => -dy, keys: { ArrowUp: 1, ArrowDown: -1 }, orientation: 'horizontal' },
  right: {
    grow: (dx) => dx,
    keys: { ArrowRight: 1, ArrowLeft: -1 },
    orientation: 'vertical',
    styleClass: styles.right!,
  },
  // A corner: the dominant axis wins, so a drag along either edge is full speed.
  'down-right': {
    grow: (dx, dy) => (Math.abs(dx) >= Math.abs(dy) ? dx : dy),
    keys: { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 },
    orientation: 'vertical',
    styleClass: styles.corner!,
    glyph: UI_ICONS.resizeCorner, // the OS's diagonal ridges (iconography.md)
  },
};

export class ResizeHandle {
  readonly el: HTMLElement;

  private readonly dir: DirectionSpec;
  /** What the property holds now; `null` while unset (automatic). */
  private current: number | null;
  /** What the user chose — the commit, or the stored initial. A bound that
   *  clamps `current` leaves this alone, so the choice comes back with room. */
  private preferred: number | null;
  private lo: number;
  private hi: number;
  private dragging = false;
  private moved = false;
  private startX = 0;
  private startY = 0;
  private startValue = 0;
  /** -Infinity, not 0: at 0 the first press within 350ms of page load would
   *  read as a double-tap and reset the size out from under the user. */
  private lastTap = Number.NEGATIVE_INFINITY;
  /** rAF-coalesced write (REQ-a-handle-commits-on-release): a fast drag costs one style write per frame. */
  private pendingValue: number | null = null;
  private rafId = 0;

  constructor(private readonly opts: ResizeHandleOptions) {
    this.dir = DIRECTIONS[opts.direction ?? 'up'];
    this.lo = opts.min;
    this.hi = opts.max;

    this.el = document.createElement('div');
    this.el.className = [styles.root!, this.dir.styleClass, opts.className].filter(Boolean).join(' ');
    this.el.dataset.testid = opts.testId;
    this.el.title = opts.title;
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'separator');
    this.el.setAttribute('aria-orientation', this.dir.orientation);
    this.el.setAttribute('aria-label', opts.label);
    this.writeAriaBounds();

    const grip = document.createElement('div');
    grip.className = styles.grip!;
    if (this.dir.glyph) grip.innerHTML = this.dir.glyph;
    this.el.appendChild(grip);

    // Write the property immediately so the target and aria agree from frame one;
    // an automatic handle writes nothing, so the CSS default renders.
    // With live bounds the target may not be laid out yet, so the first
    // `refresh()` does the clamping rather than the static range.
    this.current = null;
    this.preferred = opts.initial === null || !Number.isFinite(opts.initial)
      ? null
      : opts.bounds ? Math.round(opts.initial) : this.clamp(opts.initial);
    if (this.preferred !== null) this.apply(this.preferred);

    this.el.addEventListener('pointerdown', this.onPointerDown);
    this.el.addEventListener('keydown', this.onKeyDown);
  }

  /** The size in px, or `null` while automatic. */
  get value(): number | null {
    return this.current;
  }

  /** Set (clamped) and write through immediately — used by tests and callers. */
  set(px: number): void {
    this.cancelFrame();
    this.apply(this.clamp(px));
  }

  /**
   * Re-read the bounds (REQ-a-handle-may-have-live-bounds): clamp the user's
   * choice into them without committing, and hide the grip when there is no
   * range left to drag through.
   */
  refresh(): void {
    this.readBounds();
    this.el.hidden = this.hi <= this.lo;
    if (this.preferred !== null) {
      const next = this.clamp(this.preferred);
      if (next !== this.current) this.apply(next);
    }
  }

  private readBounds(): void {
    const b = this.opts.bounds?.();
    this.lo = b ? Math.round(b.min) : this.opts.min;
    this.hi = b ? Math.max(this.lo, Math.round(b.max)) : this.opts.max;
    this.writeAriaBounds();
  }

  private writeAriaBounds(): void {
    this.el.setAttribute('aria-valuemin', String(this.lo));
    this.el.setAttribute('aria-valuemax', String(this.hi));
  }

  private clamp(px: number): number {
    if (!Number.isFinite(px)) return this.opts.defaultValue;
    return Math.min(this.hi, Math.max(this.lo, Math.round(px)));
  }

  /** Where a gesture starts: the set size, else the measured automatic one. */
  private base(): number {
    return this.current ?? this.opts.measure?.() ?? this.opts.defaultValue;
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
    if (this.current === null) return;
    this.preferred = this.current;
    this.opts.onCommit(this.current);
  }

  /** Double-tap / `Home`: automatic again with `onReset`, else the default. */
  private reset(): void {
    if (this.opts.onReset) {
      this.cancelFrame();
      this.current = null;
      this.preferred = null;
      this.opts.target.style.removeProperty(this.opts.cssVar);
      this.el.removeAttribute('aria-valuenow');
      this.opts.onReset();
      return;
    }
    this.set(this.opts.defaultValue);
    this.commit();
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Stops the page scrolling out from under a touch drag, and stops the
    // browser starting a text selection on a mouse drag.
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId); // jsdom has none

    const now = performance.now();
    if (now - this.lastTap < DOUBLE_TAP_MS) {
      this.lastTap = Number.NEGATIVE_INFINITY; // a third tap is not a second one
      this.reset();
      return;
    }
    this.lastTap = now;

    this.dragging = true;
    this.moved = false;
    // Measure once per gesture (recipes/add-a-ui-component.md) — the stroke is
    // pure arithmetic from here, no layout reads.
    this.readBounds();
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startValue = this.base();
    this.el.classList.add('dragging');
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const next = this.clamp(this.startValue + this.dir.grow(e.clientX - this.startX, e.clientY - this.startY));
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
    // A press that never moved is not a resize — leave the size, write nothing.
    if (this.moved) this.commit();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Home') {
      e.preventDefault();
      // Already at the default: a key that changes nothing commits nothing.
      if (!this.opts.onReset && this.clamp(this.opts.defaultValue) === this.current) return;
      this.reset();
      return;
    }
    const sign = this.dir.keys[e.key];
    if (sign === undefined) return;
    e.preventDefault();
    this.readBounds();
    const from = this.base();
    const clamped = this.clamp(from + sign * this.opts.step);
    if (clamped === this.current || (this.current === null && clamped === Math.round(from))) return;
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
