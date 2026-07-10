import styles from '../styles/knob.module.css';
import type { ParamBus, ParamDef } from '../../state/params';
import { toNorm, fromNorm } from './taper';

export interface KnobOptions {
  bus: ParamBus;
  paramId: string;
  label?: string;
  size?: number;
}

const SWEEP_DEG = 280; // Knob sweeps from -140° to +140°

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

    this.unsubscribe = bus.subscribe(opts.paramId, (v) => this.render(v));
  }

  private render(value: number): void {
    const norm = this.normalize(value);
    const startDeg = -SWEEP_DEG / 2;
    const deg = startDeg + norm * SWEEP_DEG;
    this.indicator.style.transform = `translateX(-50%) rotate(${deg}deg)`;
    const dashOn = (this.circumference * SWEEP_DEG) / 360;
    const visible = dashOn * norm;
    this.arc.setAttribute('stroke-dasharray', `${visible} ${this.circumference - visible}`);
    this.valueLabel.textContent = this.formatValue(value);
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
