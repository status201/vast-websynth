import styles from '../styles/segmented.module.css';
import type { ParamBus } from '../../state/params';

export class Segmented {
  readonly el: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private unsub: () => void = () => {};

  constructor(bus: ParamBus, paramId: string, labels: string[], icons?: string[]) {
    this.el = document.createElement('div');
    this.el.className = icons ? `${styles.root!} ${styles.icons!}` : styles.root!;
    this.el.dataset.testid = `seg-${paramId}`;

    labels.forEach((label, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.testid = `seg-${paramId}-${idx}`;
      const glyph = icons?.[idx];
      if (glyph) {
        b.innerHTML = glyph;
        b.classList.add('icon');
        b.title = label;
        b.setAttribute('aria-label', label);
      } else {
        b.textContent = label;
      }
      b.addEventListener('click', () => bus.set(paramId, idx));
      this.el.appendChild(b);
      this.buttons.push(b);
    });

    this.unsub = bus.subscribe(paramId, (v) => {
      const idx = Math.round(v);
      this.buttons.forEach((b, i) => b.classList.toggle('active', i === idx));
    });
  }

  /**
   * Dim the switch and refuse input, keeping its place and its value — the
   * `Knob.setDisabled` look (voicing.md REQ-the-trigger-switches-dim-in-poly). The
   * native `disabled` blocks the click and the keyboard alike; `why` becomes the
   * tooltip while dimmed, so the control says what would bring it back.
   */
  setDisabled(on: boolean, why?: string): void {
    this.el.classList.toggle(styles.disabled!, on);
    this.el.setAttribute('aria-disabled', String(on));
    for (const b of this.buttons) b.disabled = on;
    if (on && why) this.el.title = why;
    else this.el.removeAttribute('title');
  }

  destroy(): void {
    this.unsub();
  }
}
