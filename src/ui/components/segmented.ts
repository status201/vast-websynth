import type { ParamBus } from '../../state/params';

export class Segmented {
  readonly el: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private unsub: () => void = () => {};

  constructor(bus: ParamBus, paramId: string, labels: string[]) {
    this.el = document.createElement('div');
    this.el.className = 'segmented';

    labels.forEach((label, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => bus.set(paramId, idx));
      this.el.appendChild(b);
      this.buttons.push(b);
    });

    this.unsub = bus.subscribe(paramId, (v) => {
      const idx = Math.round(v);
      this.buttons.forEach((b, i) => b.classList.toggle('active', i === idx));
    });
  }

  destroy(): void {
    this.unsub();
  }
}
