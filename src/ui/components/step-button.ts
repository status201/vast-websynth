import styles from '../styles/step-button.module.css';

/**
 * Compact step cell used by the sequencer and drum machine.
 * Click toggles on/off. Render as a small lit/unlit square; the parent
 * gives it semantic meaning (note, drum hit, etc.).
 */
export class StepButton {
  readonly el: HTMLButtonElement;
  private _on = false;
  private _playing = false;

  private static ACCENT_CLASS: Record<string, string> = {
    orange: '',
    red: styles.red!,
    yellow: styles.yellow!,
  };

  constructor(label: string, accent: 'orange' | 'red' | 'yellow' = 'orange') {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = `${styles.root!} ${StepButton.ACCENT_CLASS[accent] ?? ''}`.trim();
    this.el.textContent = label;
  }

  setOn(on: boolean): void {
    this._on = on;
    this.el.classList.toggle(styles.on!, on);
  }

  /** Highlight the currently-playing step. */
  setPlaying(p: boolean): void {
    this._playing = p;
    this.el.classList.toggle(styles.playing!, p);
  }

  setLabel(s: string): void { this.el.textContent = s; }

  get on(): boolean { return this._on; }
  get playing(): boolean { return this._playing; }

  /** Expose the root class so panels can compose selectors. */
  static get rootClass(): string { return styles.root!; }
  static get drumCellClass(): string { return styles['drum-cell']!; }
  static get selectedClass(): string { return styles.selected!; }
  static get onClass(): string { return styles.on!; }
}
