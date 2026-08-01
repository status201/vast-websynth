import styles from '../styles/knob.module.css';
import type { ParamBus, ParamDef } from '../../state/params';
import { toNorm, fromNorm } from '../../utils/taper';
import { clamp01 } from '../../utils/math';

export interface KnobOptions {
  bus: ParamBus;
  paramId: string;
  label?: string;
  size?: number;
  /**
   * Soft ceiling in **param units** (10 = 10 Hz, not a fraction): above it the
   * value arc stops filling, so travel the engine does not act on reads as dead
   * rather than live (knob-soft-ceiling.md REQ-1). Paint only — the drag, the
   * pointer line and the readout still cover the whole registered range.
   */
  uiMax?: number;
}

const SWEEP_DEG = 280; // Knob sweeps from -140° to +140°

/**
 * Decimal places kept when rounding the indicator angle / arc dash for the
 * repaint guards in `render`. Two places is ~0.005° and ~0.01 px on a 56 px
 * dial — far below anything a display can resolve, so the rounding is invisible
 * while collapsing the redundant writes an automated sweep produces.
 */
const ROTATION_PRECISION = 2;
const ARC_PRECISION = 2;

export class Knob {
  readonly el: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly arc: SVGCircleElement;
  private readonly valueLabel: HTMLElement;
  private readonly def: ParamDef;
  private unsubscribe: () => void = () => {};
  private dragging = false;
  private startY = 0;
  private startValue = 0;
  private fine = false;
  private lastTap = 0;
  private disabled = false;
  private circumference: number;
  /** Soft ceiling as a normalized position — converted once on set, not per
   *  frame. `1` (the default) means no ceiling. See `setUiMax`. */
  private uiMaxNorm = 1;
  /** Last values actually written to the DOM — see `render`. */
  private lastDeg = '';
  private lastDash = '';
  private lastLabel = '';

  constructor(private readonly opts: KnobOptions) {
    const bus = opts.bus;
    const def = bus.def(opts.paramId);
    if (!def) throw new Error(`Unknown param: ${opts.paramId}`);
    this.def = def;

    this.el = document.createElement('div');
    this.el.className = styles.root!;
    this.el.dataset.testid = `knob-${opts.paramId}`;
    if (opts.size) this.el.style.setProperty('--knob-size', `${opts.size}px`);

    const label = document.createElement('div');
    label.className = styles.label!;
    label.textContent = opts.label ?? this.deriveLabel(opts.paramId);
    this.el.appendChild(label);

    const dial = document.createElement('div');
    dial.className = styles.dial!;

    this.indicator = document.createElement('div');
    this.indicator.className = styles.indicator!;
    dial.appendChild(this.indicator);

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', styles.arc!);
    svg.setAttribute('viewBox', '0 0 56 56');
    const trackCircle = document.createElementNS(svgNS, 'circle');
    trackCircle.setAttribute('class', styles.track!);
    trackCircle.setAttribute('cx', '28');
    trackCircle.setAttribute('cy', '28');
    trackCircle.setAttribute('r', '26');
    const valueCircle = document.createElementNS(svgNS, 'circle');
    valueCircle.setAttribute('class', styles.value!);
    valueCircle.setAttribute('cx', '28');
    valueCircle.setAttribute('cy', '28');
    valueCircle.setAttribute('r', '26');
    this.circumference = 2 * Math.PI * 26;
    const dashOn = (this.circumference * SWEEP_DEG) / 360;
    const dashOff = this.circumference - dashOn;
    valueCircle.setAttribute('stroke-dasharray', `${dashOn} ${dashOff}`);
    // Rotate so the sweep starts at -140° from top
    valueCircle.setAttribute('transform', `rotate(${90 + (360 - SWEEP_DEG) / 2} 28 28)`);
    trackCircle.setAttribute('stroke-dasharray', `${dashOn} ${dashOff}`);
    trackCircle.setAttribute('transform', `rotate(${90 + (360 - SWEEP_DEG) / 2} 28 28)`);
    svg.appendChild(trackCircle);
    svg.appendChild(valueCircle);
    dial.appendChild(svg);

    this.arc = valueCircle;
    this.el.appendChild(dial);

    this.valueLabel = document.createElement('div');
    this.valueLabel.className = styles.num!;
    this.el.appendChild(this.valueLabel);

    // Drag listeners are attached to `window` on pointerdown and removed on
    // pointerup/destroy (see specs/recipes/add-a-ui-component.md) — a
    // constructor-attached window listener would leak on every rebuilt Knob
    // (the drum tuning strip rebuilds on track change) and run on every page
    // pointer move.
    dial.addEventListener('pointerdown', this.onPointerDown);

    // Before the subscribe: `subscribe` fires immediately, so the very first
    // paint already honours the ceiling and no separate repaint is needed.
    if (opts.uiMax !== undefined) this.applyUiMax(opts.uiMax);

    this.unsubscribe = bus.subscribe(opts.paramId, (v) => this.render(v));
  }

  /**
   * Paint the dial. Each of the three writes is guarded on what it is about to
   * *write* rather than on the incoming value, so the DOM never lags behind the
   * latest value at the resolution actually rendered (the same discipline as
   * `Scope.mirrorPeak` and `StepButton.setViz`; runtime-performance.md REQ-7).
   *
   * This matters because a knob is not only dragged: the motion sequencer
   * automates up to four params at frame rate, and a slow sweep re-writes the
   * same rounded angle and the same formatted string for many frames running.
   * The angle is rounded to ROTATION_PRECISION first — finer than a knob 56 px
   * across can show — which is what turns "almost always different" into
   * "usually the same".
   */
  private render(value: number): void {
    const norm = this.normalize(value);
    const startDeg = -SWEEP_DEG / 2;
    const deg = (startDeg + norm * SWEEP_DEG).toFixed(ROTATION_PRECISION);
    if (deg !== this.lastDeg) {
      this.lastDeg = deg;
      this.indicator.style.transform = `translateX(-50%) rotate(${deg}deg)`;
    }

    // The arc — and only the arc — stops at the soft ceiling
    // (knob-soft-ceiling.md REQ-2). Capping *before* the `lastDash` guard means a
    // value moving around above the ceiling writes nothing at all, so a capped
    // knob is cheaper to automate than an uncapped one, never dearer (REQ-7).
    const dashOn = (this.circumference * SWEEP_DEG) / 360;
    const visible = dashOn * Math.min(norm, this.uiMaxNorm);
    const dash = `${visible.toFixed(ARC_PRECISION)} ${(this.circumference - visible).toFixed(ARC_PRECISION)}`;
    if (dash !== this.lastDash) {
      this.lastDash = dash;
      this.arc.setAttribute('stroke-dasharray', dash);
    }

    const label = this.formatValue(value);
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.valueLabel.textContent = label;
    }
  }

  private normalize(v: number): number {
    return toNorm(this.def, v);
  }

  private denormalize(n: number): number {
    return fromNorm(this.def, n);
  }

  private formatValue(v: number): string {
    if (this.def.taper === 'discrete' && this.def.labels) {
      return this.def.labels[Math.round(v - this.def.min)] ?? String(v);
    }
    if (this.def.format) return this.def.format(v);
    return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
  }

  private deriveLabel(id: string): string {
    return id.split('.').pop()!.toUpperCase();
  }

  /**
   * Set (or clear, with `null`) the soft ceiling — the point past which the
   * value arc stops filling (knob-soft-ceiling.md REQ-4). Given in **param
   * units**, so `setUiMax(10)` on `lfo.rate` caps the arc at 10 Hz.
   *
   * Use this where the ceiling only applies in some states — the LFO RATE knob
   * is capped only while `lfo.dest === pulse`, because that is the only path the
   * engine clamps (oscillators.md REQ-9). Where a control is inert *entirely*,
   * `setDisabled` is the right treatment instead (REQ-8): a soft ceiling says
   * "this part of the travel does nothing", dimming says "none of it does".
   */
  setUiMax(max: number | null): void {
    if (!this.applyUiMax(max)) return;
    this.render(this.opts.bus.get(this.opts.paramId));
  }

  /** Shared by the constructor and `setUiMax`; returns whether it changed. The
   *  constructor skips the repaint because `subscribe` is about to paint anyway. */
  private applyUiMax(max: number | null): boolean {
    // `toNorm` does not clamp (only `fromNorm` does), so a ceiling outside
    // [min, max] is clamped here rather than producing an arc past full.
    const n = max === null ? 1 : clamp01(toNorm(this.def, max));
    if (n === this.uiMaxNorm) return false;
    this.uiMaxNorm = n;
    if (max === null || n >= 1) delete this.el.dataset.uimax;
    else this.el.dataset.uimax = String(max);
    return true;
  }

  /**
   * Disable input (e.g. the BPM knob while slaved — midi-clock-sync REQ-14):
   * dims the control and blocks both dragging and the double-tap reset. The bus
   * value still repaints, so the dial keeps reflecting the (external) value.
   */
  setDisabled(on: boolean): void {
    this.disabled = on;
    this.el.classList.toggle(styles.disabled!, on);
    this.el.setAttribute('aria-disabled', String(on));
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.disabled) return; // blocks drag AND double-tap reset
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const now = performance.now();
    if (now - this.lastTap < 300) {
      // Reset to the active preset/song value if one set it, else the global
      // default (see specs/features/param-reset-baseline.md).
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
    const dy = this.startY - e.clientY;
    const sensitivity = this.fine || e.shiftKey ? 600 : 200;
    const deltaNorm = dy / sensitivity;
    const startNorm = this.normalize(this.startValue);
    const newValue = this.denormalize(startNorm + deltaNorm);
    this.opts.bus.set(this.opts.paramId, newValue);
  };

  private onPointerUp = (_: PointerEvent): void => {
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
