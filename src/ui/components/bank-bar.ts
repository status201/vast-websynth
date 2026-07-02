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
  /** Optional testid namespace, e.g. 'seq' → `bank-seq-0`…`bank-seq-copy`. */
  testidPrefix?: string;
}

/**
 * A/B/C/D bank selector with a "Follow" toggle and a "Copy" arm. Click a
 * letter to edit that bank; click Copy then a letter to duplicate the current
 * bank into it. The bank the transport is currently playing gets a lit dot.
 * While Follow is on (the default) the edit bank tracks the play bank, so the
 * panel switches banks with the arrangement; clicking a non-playing bank
 * turns Follow off (click = editing intent). Session-only state.
 */
export class BankBar {
  readonly el: HTMLElement;
  private readonly btns: HTMLButtonElement[] = [];
  private copyArmed = false;
  private copyBtn!: HTMLButtonElement;
  private following = true;
  private followBtn!: HTMLButtonElement;

  constructor(private readonly opts: BankBarOpts) {
    this.el = document.createElement('div');
    this.el.className = styles.root!;

    this.followBtn = document.createElement('button');
    this.followBtn.type = 'button';
    this.followBtn.className = `${switchStyles.root!} ${styles.follow!} on`;
    if (opts.testidPrefix) this.followBtn.dataset.testid = `bank-${opts.testidPrefix}-follow`;
    this.followBtn.textContent = 'Follow';
    this.followBtn.title = 'Follow the playing bank — the view switches banks with the song';
    this.followBtn.addEventListener('click', () => this.setFollowing(!this.following));
    this.el.appendChild(this.followBtn);

    const seg = document.createElement('div');
    seg.className = styles.seg!;
    BANK_LABELS.forEach((label, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = styles.btn!;
      if (opts.testidPrefix) b.dataset.testid = `bank-${opts.testidPrefix}-${i}`;
      b.innerHTML = `<span class="${styles.letter!}">${label}</span><span class="${styles.dot!}"></span>`;
      b.addEventListener('click', () => {
        // A manual pick of a non-playing bank means editing intent — stop
        // following so the arrangement can't yank the view back next bar.
        if (this.following && i !== this.opts.getPlay()) this.setFollowing(false);
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
    if (opts.testidPrefix) this.copyBtn.dataset.testid = `bank-${opts.testidPrefix}-copy`;
    this.copyBtn.textContent = 'Copy';
    this.copyBtn.title = 'Copy this bank into another (click Copy, then a slot)';
    this.copyBtn.addEventListener('click', () => this.setArmed(!this.copyArmed));
    this.el.appendChild(this.copyBtn);

    this.render();
    opts.onEditChange(() => this.render());
    opts.onPlayChange(() => {
      this.syncToPlay();
      this.render();
    });
    opts.onContentChange(() => this.render());
  }

  private setArmed(on: boolean): void {
    this.copyArmed = on;
    this.copyBtn.classList.toggle('on', on);
    this.el.classList.toggle('copy-armed', on);
  }

  private setFollowing(on: boolean): void {
    this.following = on;
    this.followBtn.classList.toggle('on', on);
    if (on) this.syncToPlay(); // jump to the playing bank at once, not next bar
  }

  /** While following, keep the edit bank on the play bank. */
  private syncToPlay(): void {
    if (!this.following) return;
    const play = this.opts.getPlay();
    if (play !== this.opts.getEdit()) this.opts.setEdit(play);
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
