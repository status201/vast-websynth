import styles from '../styles/strip.module.css';
import type { ParamBus } from '../../state/params';

export interface StripOptions {
  bus: ParamBus;
  paramId: string;
  label: string;
  /** If true, value snaps back to default (zero) on release. */
  springBack?: boolean;
}

export class Strip {
  readonly el: HTMLElement;
  private readonly thumb: HTMLElement;
  private unsub: () => void = () => {};
  private dragging = false;
  private height = 0;
  private lastValue = 0;
  private readonly ro: ResizeObserver;

  constructor(private readonly opts: StripOptions) {
    this.el = document.createElement('div');
    this.el.className = styles.root!;
    this.el.dataset.testid = `strip-${opts.paramId}`;

    this.thumb = document.createElement('div');
    this.thumb.className = styles.thumb!;
    this.el.appendChild(this.thumb);

    const label = document.createElement('div');
    label.className = styles.label!;
    label.textContent = opts.label;
    this.el.appendChild(label);

    // Drag-scoped window listeners (see specs/recipes/add-a-ui-component.md):
    // attached on pointerdown, removed on pointerup/destroy.
    this.el.addEventListener('pointerdown', this.onDown);

    this.unsub = opts.bus.subscribe(opts.paramId, (v) => {
      this.lastValue = v;
      this.render(v);
    });

    // Re-render once laid out (initial subscribe fires before DOM sizing)
    this.ro = new ResizeObserver(() => {
      if (this.el.clientHeight > 0) this.render(this.lastValue);
    });
    this.ro.observe(this.el);
  }

  private render(value: number): void {
    const def = this.opts.bus.def(this.opts.paramId);
    if (!def) return;
    const norm = (value - def.min) / (def.max - def.min);
    const h = this.el.clientHeight || 80;
    const top = (1 - norm) * (h - 22);
    this.thumb.style.top = `${top}px`;
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.dragging = true;
    this.height = this.el.clientHeight;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    this.updateFromPointer(e.clientY);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.updateFromPointer(e.clientY);
  };

  private onUp = (_: PointerEvent): void => {
    this.detachDragListeners();
    if (!this.dragging) return;
    this.dragging = false;
    if (this.opts.springBack) {
      const def = this.opts.bus.def(this.opts.paramId);
      if (def) this.opts.bus.set(this.opts.paramId, def.default);
    }
  };

  private detachDragListeners(): void {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
  }

  private updateFromPointer(clientY: number): void {
    const rect = this.el.getBoundingClientRect();
    const rel = Math.max(0, Math.min(rect.height - 22, clientY - rect.top - 11));
    const norm = 1 - rel / (rect.height - 22);
    const def = this.opts.bus.def(this.opts.paramId);
    if (!def) return;
    let v = def.min + norm * (def.max - def.min);
    if (def.step) v = Math.round((v - def.min) / def.step) * def.step + def.min;
    this.opts.bus.set(this.opts.paramId, v);
  }

  destroy(): void {
    this.ro.disconnect();
    this.unsub();
    this.detachDragListeners();
  }
}
