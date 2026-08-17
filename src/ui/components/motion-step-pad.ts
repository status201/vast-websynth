import type { MotionStep } from '../../state/patterns';
import styles from '../styles/motion.module.css';
import { clamp01 } from '../../utils/math';

/** Peek threshold, and the double-tap window it shares (motion-sequencer REQ-23a). */
export const HOLD_MS = 350;
/** Travel that turns a press into a drag — the same slop `grid-gestures.ts` uses. */
export const SLOP_PX = 6;
/** Coarse quantization: 20 steps, so two lanes can land on the same level (REQ-23b). */
export const SNAP_STEPS = 20;
/** Px of travel spanning the full 0..1 range under Shift (REQ-23c). */
export const FINE_PX = 400;

/** Quantize to `SNAP_STEPS`. Integer division, so 8/20 is exactly 0.4 — two
 *  lanes that snap to the same step produce the identical double, which is what
 *  makes "give A and B the same value" work at all. */
function snap(v: number): number {
  return Math.round(v * SNAP_STEPS) / SNAP_STEPS;
}

/** What a live gesture is showing. `peek` never writes. */
export interface MotionGesture {
  x: number;
  y: number;
  mode: 'press' | 'drag' | 'peek';
}

export interface MotionStepPadOpts {
  /** Beat-column accent (steps 0/4/8/12), like the drum grid's red columns. */
  beat?: boolean;
  /**
   * 'xy' (default) — the two-axis pad: a dot at the literal (x, y).
   * 'level' — an extra motion track's single-param cell (motion-sequencer.md
   * REQ-16): only y is meaningful and it renders as a bottom-up fill bar. The
   * gesture handling is identical, which is the point of sharing the component.
   */
  mode?: 'xy' | 'level';
  /** A drag/tap committed the coordinate (both normalized 0..1, y up = more). */
  onSet: (x: number, y: number) => void;
  /** Double-click / double-tap cleared the step. */
  onClear: () => void;
  /**
   * The live gesture, for the panel's readout (motion-sequencer.md REQ-22).
   * Fires on press, on every value change and once with `null` on release. The
   * pad reports normalized numbers only — the panel owns the parameter, so it
   * owns the formatting.
   */
  onGesture?: (g: MotionGesture | null) => void;
}

type Phase = 'idle' | 'pending' | 'drag' | 'peek';

/**
 * One motion-sequencer step: a mini XY pad (motion-sequencer.md REQ-8), or a
 * single-value level cell for the A/B lanes (REQ-16). The dot sits at the
 * literal (x, y); double-click (or a fast double-tap) clears the anchor.
 * Rendering is driven by `setStep`/`setLevel` so the panel's PatternStore
 * subscriptions stay the one source of truth (the pad never mutates state).
 *
 * The write is **deferred** (REQ-23a): a press commits on first travel or on
 * release, never at `pointerdown`, which is what leaves a stationary hold free
 * to *peek* — read the value without disturbing it. Coarse values snap to
 * 1/20 (REQ-23b) and Shift makes the drag fine, relative and unsnapped
 * (REQ-23c).
 */
export class MotionStepPad {
  readonly el: HTMLDivElement;
  private readonly dot: HTMLDivElement;
  private readonly level: boolean;
  private lastTapMs = 0;

  /** What the store last painted into this cell — the peek display and Shift's
   *  anchor both mean "what is in here right now". */
  private cellX = 0.5;
  private cellY = 0.5;

  // --- live gesture state ---
  private phase: Phase = 'idle';
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private pressClientX = 0;
  private pressClientY = 0;
  /** The value the gesture is currently showing (and, once dragging, writing). */
  private curX = 0.5;
  private curY = 0.5;
  /** What a tap would commit — the press position, or the cell's own value when
   *  Shift is held (REQ-23c: pressing with Shift must not jump). */
  private pendingX = 0.5;
  private pendingY = 0.5;
  /**
   * Latched once Shift has been seen: from then on the stroke maps movement
   * *relative* to an anchor rather than absolutely. Returning to absolute
   * mid-stroke would teleport the value to the pointer, so it never does.
   */
  private relative = false;
  private beat = false;
  private fine = false;
  private anchorClientX = 0;
  private anchorClientY = 0;
  private anchorX = 0.5;
  private anchorY = 0.5;

  constructor(private readonly opts: MotionStepPadOpts) {
    this.level = opts.mode === 'level';
    this.el = document.createElement('div');
    this.el.className = styles.pad!
      + (opts.beat ? ` ${styles.beat!}` : '')
      + (this.level ? ` ${styles.levelPad!}` : '');
    this.beat = opts.beat ?? false;

    this.dot = document.createElement('div');
    this.dot.className = this.level ? styles.bar! : styles.dot!;
    this.el.appendChild(this.dot);

    // Own phase machine + optional capture, like xy-pad.ts (jsdom-safe).
    this.el.addEventListener('pointerdown', (e) => {
      // Manual double-tap detection: dblclick is unreliable for touch, and we
      // want the clear to win over any set the first tap applied.
      const now = Date.now();
      if (now - this.lastTapMs < HOLD_MS) {
        this.lastTapMs = 0;
        this.endGesture();
        this.opts.onClear();
        return;
      }
      this.lastTapMs = now;
      e.preventDefault();
      this.el.setPointerCapture?.(e.pointerId);

      this.phase = 'pending';
      this.pressClientX = e.clientX;
      this.pressClientY = e.clientY;
      // Nothing is written yet, so the readout shows what is actually in the
      // cell. Shift held at press anchors here too, so it never jumps.
      this.curX = this.cellX;
      this.curY = this.cellY;
      this.relative = e.shiftKey;
      this.fine = e.shiftKey;
      this.reanchor(e);
      const at = this.absoluteAt(e);
      this.pendingX = e.shiftKey || !at ? this.cellX : at.x;
      this.pendingY = e.shiftKey || !at ? this.cellY : at.y;
      this.report('press');

      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        if (this.phase !== 'pending') return;
        this.phase = 'peek';
        // A fired peek is not half of a double-tap. Today the two windows are
        // the same length, so this is belt-and-braces — but it is what keeps
        // shortening HOLD_MS from silently turning a read into a clear.
        this.lastTapMs = 0;
        this.report('peek');
      }, HOLD_MS);
    });

    this.el.addEventListener('pointermove', (e) => {
      if (this.phase === 'idle') return;
      if (this.phase !== 'drag') {
        const dx = e.clientX - this.pressClientX;
        const dy = e.clientY - this.pressClientY;
        if (Math.hypot(dx, dy) <= SLOP_PX) return; // still a press (or a peek)
        this.clearHold();
        this.phase = 'drag';
      }
      this.apply(e);
    });

    this.el.addEventListener('pointerup', () => {
      // A press that never travelled and never became a peek is a tap: commit
      // where the finger went down.
      if (this.phase === 'pending') this.commit(this.pendingX, this.pendingY);
      this.endGesture();
    });
    this.el.addEventListener('pointercancel', () => this.endGesture());
  }

  /** Re-base the relative mapping at the pointer's current position and value,
   *  so entering or leaving fine mode never jumps (REQ-23c). */
  private reanchor(e: PointerEvent): void {
    this.anchorClientX = e.clientX;
    this.anchorClientY = e.clientY;
    this.anchorX = this.curX;
    this.anchorY = this.curY;
  }

  private clearHold(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private endGesture(): void {
    this.clearHold();
    if (this.phase === 'idle') return;
    this.phase = 'idle';
    this.relative = false;
    this.fine = false;
    this.opts.onGesture?.(null);
  }

  private report(mode: MotionGesture['mode']): void {
    this.opts.onGesture?.({ x: this.curX, y: this.curY, mode });
  }

  private commit(x: number, y: number): void {
    this.curX = x;
    this.curY = y;
    this.opts.onSet(x, y);
  }

  /** The snapped value the pointer is directly over, or null if the pad has no
   *  layout yet (jsdom, or a hidden panel). */
  private absoluteAt(e: PointerEvent, r?: DOMRect): { x: number; y: number } | null {
    const rect = r ?? this.el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: snap(clamp01((e.clientX - rect.left) / rect.width)),
      y: snap(clamp01(1 - (e.clientY - rect.top) / rect.height)), // up = more
    };
  }

  private apply(e: PointerEvent): void {
    // One rect read per move: this runs at pointer rate and forces layout.
    const r = this.el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const fineNow = e.shiftKey;
    if (fineNow && !this.relative) {
      this.relative = true; // entering fine from an absolute stroke
      this.reanchor(e);
    } else if (this.relative && fineNow !== this.fine) {
      this.reanchor(e); // Shift toggled mid-stroke — re-base, do not jump
    }
    this.fine = fineNow;

    if (this.relative) {
      // Coarse-relative uses the pad's own dimensions, so leaving fine mode
      // feels exactly like the absolute mapping it replaced.
      const sx = fineNow ? FINE_PX : r.width;
      const sy = fineNow ? FINE_PX : r.height;
      let x = clamp01(this.anchorX + (e.clientX - this.anchorClientX) / sx);
      let y = clamp01(this.anchorY - (e.clientY - this.anchorClientY) / sy); // up = more
      if (!fineNow) {
        x = snap(x);
        y = snap(y);
      }
      this.commit(x, y);
    } else {
      const at = this.absoluteAt(e, r)!; // r is already known non-degenerate
      this.commit(at.x, at.y);
    }
    this.report('drag');
  }

  /** Repaint from the store's cell: lit state + dot position. */
  /**
   * Move the beat accent (meter.md REQ-8) — the same surface `StepButton`
   * exposes, so `bindLaneGrid` can drive an XY lane and a trigger grid through
   * one code path. `'orange'` here means "not a beat column".
   */
  setAccent(accent: 'orange' | 'red' | 'yellow'): void {
    const beat = accent !== 'orange';
    if (beat === this.beat) return;
    this.beat = beat;
    this.el.classList.toggle(styles.beat!, beat);
  }

  /** Hide a cell the lane does not reach (meter.md REQ-11); the step is kept. */
  setLive(live: boolean): void {
    this.el.hidden = !live;
  }

  setStep(step: MotionStep): void {
    this.cellX = step.x;
    this.cellY = step.y;
    this.el.classList.toggle('on', step.on); // global state class (see src/ui/CLAUDE.md)
    this.dot.style.left = `${step.x * 100}%`;
    this.dot.style.top = `${(1 - step.y) * 100}%`;
    this.el.title = step.on
      ? `x ${step.x.toFixed(2)} · y ${step.y.toFixed(2)}`
        + ' — drag to set (Shift: fine), hold to read, double-click to clear'
      : 'Drag to set an XY anchor (Shift: fine)';
  }

  /** Repaint a level-mode cell from an extra track's step (REQ-16). */
  setLevel(on: boolean, v: number, paramLabel?: string): void {
    this.cellY = v;
    this.el.classList.toggle('on', on);
    this.dot.style.height = `${v * 100}%`;
    this.el.title = on
      ? `${paramLabel ? paramLabel + ' · ' : ''}${v.toFixed(2)}`
        + ' — drag to set (Shift: fine), hold to read, double-click to clear'
      : (paramLabel ? `Drag to set ${paramLabel} (Shift: fine)`
                    : 'Pick a parameter for this track first');
  }

  /** A track with no parameter chosen has nothing to write, so its cells are
   *  inert — the parameter IS the on/off (REQ-16). */
  setInert(inert: boolean): void {
    this.el.classList.toggle(styles.inert!, inert);
  }

  setPlaying(p: boolean): void {
    this.el.classList.toggle('playing', p);
  }
}
