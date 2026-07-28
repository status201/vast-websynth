import styles from '../styles/stepper.module.css';
import type { ParamBus, ParamDef } from '../../state/params';
import { clamp } from '../../utils/math';

export interface StepperOptions {
  bus: ParamBus;
  paramId: string;
  label?: string;
  /**
   * Values the drag snaps to when it lands within one step of them — the
   * musically meaningful counts (e.g. `[1,2,4,8,16,32,64]` for Zoetrope's
   * depth). Everything between them stays reachable, and shift bypasses them.
   * A call-site concern, not a param property: the same param can be meaningful
   * with different magnets elsewhere.
   */
  magnets?: readonly number[];
}

/** Pixels of drag per step; matches `Knob`'s coarse feel at a 64-value range. */
const SENSITIVITY = 14;
const FINE_SENSITIVITY = 40;

/**
 * A boxed integer readout bound to a param, dragged vertically through whole
 * values. For a parameter that is a **count**, a knob is a lie — it invites
 * hunting for a precision that does not exist. See param-controls.md.
 *
 * Shares `Knob`'s gestures deliberately: shift for fine control, double-tap to
 * reset to the loaded preset/song baseline, drag listeners attached to `window`
 * on pointerdown only (add-a-ui-component.md).
 */
export class Stepper {
  readonly el: HTMLElement;
  private readonly valueEl: HTMLElement;
  private readonly def: ParamDef;
  private readonly step: number;
  private unsubscribe: () => void = () => {};
  private dragging = false;
  private startY = 0;
  private startValue = 0;
  private fine = false;
  private lastTap = 0;
  private lastLabel = '';

  constructor(private readonly opts: StepperOptions) {
    const def = opts.bus.def(opts.paramId);
    if (!def) throw new Error(`Unknown param: ${opts.paramId}`);
    this.def = def;
    this.step = def.step && def.step > 0 ? def.step : 1;

    this.el = document.createElement('div');
    this.el.className = styles.root!;
    this.el.dataset.testid = `stepper-${opts.paramId}`;

    const label = document.createElement('div');
    label.className = styles.label!;
    label.textContent = opts.label ?? opts.paramId.split('.').pop()!.toUpperCase();
    this.el.appendChild(label);

    this.valueEl = document.createElement('div');
    this.valueEl.className = styles.box!;
    this.el.appendChild(this.valueEl);

    this.valueEl.addEventListener('pointerdown', this.onPointerDown);
    this.unsubscribe = opts.bus.subscribe(opts.paramId, (v) => this.render(v));
  }

  /** Guarded on the string actually written — a count re-renders identically for
   *  most of a drag, and the motion sequencer can automate this at frame rate. */
  private render(value: number): void {
    const text = this.format(value);
    if (text === this.lastLabel) return;
    this.lastLabel = text;
    this.valueEl.textContent = text;
  }

  private format(v: number): string {
    if (this.def.taper === 'discrete' && this.def.labels) {
      return this.def.labels[Math.round(v - this.def.min)] ?? String(v);
    }
    if (this.def.format) return this.def.format(v);
    return v.toFixed(0);
  }

  /** Snap to the nearest magnet within one step; shift (fine) bypasses them. */
  private snap(v: number): number {
    const magnets = this.opts.magnets;
    if (!magnets) return v;
    for (const m of magnets) {
      if (Math.abs(v - m) <= this.step) return m;
    }
    return v;
  }

  private onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const now = performance.now();
    if (now - this.lastTap < 300) {
      this.opts.bus.reset(this.opts.paramId);
      this.lastTap = 0;
      return;
    }
    this.lastTap = now;

    this.dragging = true;
    this.startY = e.clientY;
    this.startValue = this.opts.bus.get(this.opts.paramId);
    this.fine = e.shiftKey;
    this.el.classList.add('dragging');
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const fine = this.fine || e.shiftKey;
    const dy = this.startY - e.clientY;
    const steps = Math.round(dy / (fine ? FINE_SENSITIVITY : SENSITIVITY));
    const raw = this.startValue + steps * this.step;
    const v = clamp(fine ? raw : this.snap(raw), this.def.min, this.def.max);
    this.opts.bus.set(this.opts.paramId, v);
  };

  private onPointerUp = (): void => {
    this.detachDragListeners();
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('dragging');
  };

  private detachDragListeners(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  destroy(): void {
    this.unsubscribe();
    this.detachDragListeners();
  }
}
