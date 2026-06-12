import styles from '../styles/gr-meter.module.css';

const FULL_SCALE_DB = 20;

/**
 * Tiny gain-reduction meter: a right-anchored bar that grows leftward with
 * gain reduction (0–20 dB scale), like a hardware GR needle resting at zero.
 * Driven directly by the compressor worklet's ~31 Hz port messages.
 */
export class GrMeter {
  readonly el: HTMLElement;
  private readonly fill: HTMLElement;

  constructor(testid?: string) {
    this.el = document.createElement('div');
    this.el.className = styles.root!;
    this.el.title = 'gain reduction';
    if (testid) this.el.dataset.testid = testid;
    this.fill = document.createElement('div');
    this.fill.className = styles.fill!;
    this.el.appendChild(this.fill);
  }

  update(db: number): void {
    const pct = Math.min(Math.max(db, 0), FULL_SCALE_DB) / FULL_SCALE_DB * 100;
    this.fill.style.width = `${pct}%`;
  }
}
