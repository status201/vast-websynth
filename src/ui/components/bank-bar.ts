import styles from '../styles/bank-bar.module.css';
import switchStyles from '../styles/switch.module.css';
import { BANK_LABELS } from '../../state/patterns';

export interface BankBarOpts {
  getEdit(): number;
  setEdit(i: number): void;
  copy(from: number, to: number): void;
  onEditChange(fn: () => void): () => void;
  getPlay(): number;
  onPlayChange(fn: () => void): () => void;
  /** True when bank `i` holds at least one active step/note. */
  hasContent(i: number): boolean;
  /** Subscribe to pattern mutations so the filled indicator stays live. */
  onContentChange(fn: () => void): () => void;
}

/**
 * A/B/C/D bank selector with a "Copy" arm. Click a letter to edit that
 * bank; click Copy then a letter to duplicate the current bank into it.
 * The bank the transport is currently playing gets a lit dot.
 */
export class BankBar {
  readonly el: HTMLElement;
  private readonly btns: HTMLButtonElement[] = [];
  private copyArmed = false;
  private copyBtn!: HTMLButtonElement;

  constructor(private readonly opts: BankBarOpts) {
    this.el = document.createElement('div');
    this.el.className = styles.root!;

    const seg = document.createElement('div');
    seg.className = styles.seg!;
    BANK_LABELS.forEach((label, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = styles.btn!;
      b.innerHTML = `<span class="${styles.letter!}">${label}</span><span class="${styles.dot!}"></span>`;
      b.addEventListener('click', () => {
        if (this.copyArmed) {
          this.opts.copy(this.opts.getEdit(), i);
          this.setArmed(false);
          this.opts.setEdit(i);
        } else {
          this.opts.setEdit(i);
        }
      });
      this.btns.push(b);
      seg.appendChild(b);
    });
    this.el.appendChild(seg);

    this.copyBtn = document.createElement('button');
    this.copyBtn.type = 'button';
    this.copyBtn.className = `${switchStyles.root!} ${styles.copy!}`;
    this.copyBtn.textContent = 'Copy';
    this.copyBtn.title = 'Copy this bank into another (click Copy, then a slot)';
    this.copyBtn.addEventListener('click', () => this.setArmed(!this.copyArmed));
    this.el.appendChild(this.copyBtn);

    this.render();
    opts.onEditChange(() => this.render());
    opts.onPlayChange(() => this.render());
    opts.onContentChange(() => this.render());
  }

  private setArmed(on: boolean): void {
    this.copyArmed = on;
    this.copyBtn.classList.toggle('on', on);
    this.el.classList.toggle('copy-armed', on);
  }

  private render(): void {
    const edit = this.opts.getEdit();
    const play = this.opts.getPlay();
    this.btns.forEach((b, i) => {
      b.classList.toggle('active', i === edit);
      b.classList.toggle('playing', i === play);
      b.classList.toggle('filled', this.opts.hasContent(i));
    });
  }
}
