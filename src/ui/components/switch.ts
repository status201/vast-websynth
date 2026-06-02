import styles from '../styles/switch.module.css';
import type { ParamBus } from '../../state/params';

export class Switch {
  readonly el: HTMLButtonElement;
  private unsub: () => void = () => {};

  constructor(bus: ParamBus, paramId: string, label: string) {
    this.el = document.createElement('button');
    this.el.className = styles.root!;
    this.el.type = 'button';
    this.el.dataset.testid = `switch-${paramId}`;
    const led = document.createElement('span');
    led.className = styles.led!;
    this.el.appendChild(led);
    const text = document.createElement('span');
    text.className = `${styles.label!} switch-label`;
    text.textContent = label;
    this.el.appendChild(text);

    this.el.addEventListener('click', () => {
      const cur = bus.get(paramId);
      bus.set(paramId, cur >= 0.5 ? 0 : 1);
    });

    this.unsub = bus.subscribe(paramId, (v) => {
      if (v >= 0.5) this.el.classList.add('on');
      else this.el.classList.remove('on');
    });
  }

  destroy(): void {
    this.unsub();
  }
}
