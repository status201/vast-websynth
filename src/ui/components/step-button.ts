import styles from '../styles/step-button.module.css';

/**
 * Per-step settings a button can visualize on its face. Structurally
 * compatible with `SeqStep` so panels can pass the step object straight in.
 */
export interface StepViz {
  velocity: number; // 0..1 → fill brightness
  gate: number;     // 0..1 → fill width
  prob: number;     // <1 → dashed border
  ratchet: number;  // >1 → tick marks on the top edge
  tie: boolean;     // fill bridges into the next cell
}

/**
 * Compact step cell used by the sequencer and drum machine.
 * Click toggles on/off. Render as a small lit/unlit square; the parent
 * gives it semantic meaning (note, drum hit, etc.).
 */
export class StepButton {
  readonly el: HTMLButtonElement;
  private readonly labelSpan: HTMLSpanElement;
  private _on = false;
  private _playing = false;
  private viz: StepViz | null = null;

  private static ACCENT_CLASS: Record<string, string> = {
    orange: '',
    red: styles.red!,
    yellow: styles.yellow!,
  };

  constructor(label: string, accent: 'orange' | 'red' | 'yellow' = 'orange') {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = `${styles.root!} ${StepButton.ACCENT_CLASS[accent] ?? ''}`.trim();
    this.labelSpan = document.createElement('span');
    this.labelSpan.className = styles.label!;
    this.labelSpan.textContent = label;
    this.el.appendChild(this.labelSpan);
  }

  setOn(on: boolean): void {
    if (this._on === on) return;
    this._on = on;
    this.el.classList.toggle(styles.on!, on);
  }

  /** Highlight the currently-playing step. */
  setPlaying(p: boolean): void {
    if (this._playing === p) return;
    this._playing = p;
    this.el.classList.toggle(styles.playing!, p);
  }

  setLabel(s: string): void { this.labelSpan.textContent = s; }

  /**
   * Visualize per-step settings on the button face (all three machines call
   * this). The fill layer is created lazily on first call; values are cached
   * so repeated calls with the same settings touch no styles.
   */
  setViz(v: StepViz): void {
    const prev = this.viz;
    if (!prev) {
      const fill = document.createElement('div');
      fill.className = styles.fill!;
      this.el.insertBefore(fill, this.labelSpan);
      this.el.classList.add(styles['has-viz']!);
    }
    if (prev?.gate !== v.gate) this.el.style.setProperty('--sb-gate', String(v.gate));
    if (prev?.velocity !== v.velocity) this.el.style.setProperty('--sb-vel', String(v.velocity));
    if (prev?.ratchet !== v.ratchet) {
      this.el.style.setProperty('--sb-ratchet', String(v.ratchet));
      this.el.classList.toggle(styles.ratchet!, v.ratchet > 1);
    }
    if (prev?.prob !== v.prob) this.el.classList.toggle(styles.prob!, v.prob < 1);
    if (prev?.tie !== v.tie) this.el.classList.toggle(styles.tie!, v.tie);
    this.viz = { velocity: v.velocity, gate: v.gate, prob: v.prob, ratchet: v.ratchet, tie: v.tie };
  }

  get on(): boolean { return this._on; }
  get playing(): boolean { return this._playing; }

  /** Expose the root class so panels can compose selectors. */
  static get rootClass(): string { return styles.root!; }
  static get drumCellClass(): string { return styles['drum-cell']!; }
  static get selectedClass(): string { return styles.selected!; }
  /** Ring shown while a long-press is registered (step-grid-editing.md REQ-3). */
  static get heldClass(): string { return styles.held!; }
  static get onClass(): string { return styles.on!; }
  static get fillClass(): string { return styles.fill!; }
  static get tieClass(): string { return styles.tie!; }
  static get probClass(): string { return styles.prob!; }
  static get ratchetClass(): string { return styles.ratchet!; }
}
