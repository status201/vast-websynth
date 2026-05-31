import styles from '../styles/dropdown.module.css';
import type { ParamBus } from '../../state/params';
import { Dropdown } from './dropdown';

/**
 * Binds the vintage `Dropdown` to a discrete `ParamBus` param, mapping the
 * param's numeric index ↔ its label (same role `Segmented` plays for
 * segmented controls). Used where a 5-option segmented row won't fit a
 * narrow panel column (LFO destination).
 */
export class ParamDropdown {
  readonly el: HTMLElement;
  private readonly dd: Dropdown;
  private readonly unsub: () => void;

  constructor(bus: ParamBus, paramId: string, labels: string[]) {
    this.dd = new Dropdown(labels);
    this.dd.el.classList.add(styles.compact!);
    this.el = this.dd.el;

    this.dd.onChange((v) => {
      const idx = labels.indexOf(v);
      if (idx >= 0) bus.set(paramId, idx);
    });

    // Fires immediately with the current value, and again on every change
    // (incl. song/preset loads). setValue is a no-op on equal value and
    // never re-fires onChange, so there is no feedback loop.
    this.unsub = bus.subscribe(paramId, (val) => {
      const label = labels[Math.round(val)];
      if (label !== undefined) this.dd.setValue(label);
    });
  }

  destroy(): void {
    this.unsub();
    this.dd.destroy();
  }
}
