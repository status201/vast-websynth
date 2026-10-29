import styles from '../styles/dropdown.module.css';
import type { ParamBus } from '../../state/params';
import { Dropdown, type DropdownOptions } from './dropdown';

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

  /**
   * `testId`: `Dropdown` mints no testid of its own, so a call site that needs
   * one names it here (testids.md REQ-non-param-buttons-take-an-explicit-testid).
   * `opts` goes to `Dropdown` as is (a `legend`, dropdown.md REQ-a-toggle-can-carry-a-legend).
   */
  constructor(bus: ParamBus, paramId: string, labels: string[], testId?: string, opts?: DropdownOptions) {
    this.dd = new Dropdown(labels, undefined, opts);
    this.dd.el.classList.add(styles.compact!);
    this.el = this.dd.el;
    if (testId) this.el.dataset.testid = testId;

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

  /**
   * Grey out options this param may not take right now (dropdown.md REQ-an-option-can-be-unselectable).
   *
   * A pass-through on purpose: which options are spoken for is the consumer's
   * rule, not the binder's. The first caller is the LFO panel's mutually
   * exclusive destinations (lfo.md REQ-destinations-are-no-longer-exclusive). The full `labels` array stays the
   * index authority, so disabling never disturbs the index ↔ label mapping.
   */
  setDisabledLabels(labels: readonly string[]): void {
    this.dd.setDisabledOptions(labels);
  }

  /** Inherited / idle styling on the toggle — never the root (dropdown.md REQ-a-dropdown-can-be-dimmed). */
  setDimmed(on: boolean): void {
    this.dd.setDimmed(on);
  }

  destroy(): void {
    this.unsub();
    this.dd.destroy();
  }
}
