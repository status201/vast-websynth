import styles from '../styles/bank-bar.module.css';
import switchStyles from '../styles/switch.module.css';
import { BANK_LABELS, MAX_BANK_COUNT } from '../../state/patterns';
import { UI_ICONS } from './ui-icons';
import { ListenerSet } from '../../utils/listeners';

export interface BankBarOpts {
  getEdit(): number;
  setEdit(i: number): void;
  copy(from: number, to: number): void;
  onEditChange(fn: () => void): () => void;
  getPlay(): number;
  onPlayChange(fn: () => void): () => void;
  /** True while the lane is playing a REST bar — recolours the play-bank dot
   *  amber ("resting") instead of red, since no bank is actually playing. */
  resting?(): boolean;
  /** True when bank `i` holds at least one active step/note. */
  hasContent(i: number): boolean;
  /** Subscribe to pattern mutations so the filled indicator stays live. */
  onContentChange(fn: () => void): () => void;
  /** How many banks this machine has right now, 4..8 (banks.md REQ-a-machine-owns-its-bank-count). */
  bankCount(): number;
  /** Append one blank bank. Omitted on a surface that cannot grow. */
  addBank?(): void;
  /** Drop the highest bank. Omitted on a surface that cannot shrink. */
  removeBank?(): void;
  /** Why the − arm is unavailable, or null when it is available. */
  removeBlockedBy?(): string | null;
  /** Fires whenever `bankCount()` changes — an add, a remove, or a song load. */
  onBankCountChange?(fn: () => void): () => void;
  /** Optional testid namespace, e.g. 'seq' → `bank-seq-0`…`bank-seq-copy`. */
  testidPrefix?: string;
}

/**
 * A–H bank selector with a "Follow" toggle and a "Copy" arm. Click a
 * letter to edit that bank; click Copy then a letter to duplicate the current
 * bank into it. The bank the transport is currently playing gets a lit dot.
 * While Follow is on (the default) the edit bank tracks the play bank, so the
 * panel switches banks with the arrangement; clicking a non-playing bank
 * turns Follow off (click = editing intent). Session-only state.
 */
export class BankBar {
  readonly el: HTMLElement;
  private readonly seg: HTMLElement;
  private readonly btns: HTMLButtonElement[] = [];
  private minusBtn: HTMLButtonElement | null = null;
  private copyArmed = false;
  private copyBtn!: HTMLButtonElement;
  private _following = true;
  private followBtn!: HTMLButtonElement;
  private readonly followListeners = new ListenerSet();

  constructor(private readonly opts: BankBarOpts) {
    this.el = document.createElement('div');
    this.el.className = styles.root!;

    this.followBtn = document.createElement('button');
    this.followBtn.type = 'button';
    this.followBtn.className = `${switchStyles.root!} ${styles.follow!} on`;
    if (opts.testidPrefix) this.followBtn.dataset.testid = `bank-${opts.testidPrefix}-follow`;
    this.followBtn.textContent = 'Follow';
    this.followBtn.title = 'Follow the playing bank — the view switches banks with the song';
    this.followBtn.addEventListener('click', () => this.setFollowing(!this._following));
    this.el.appendChild(this.followBtn);

    // Created here for document order; filled after copyBtn exists, because
    // renderSegment() re-applies the copy-armed state onto it.
    this.seg = document.createElement('div');
    this.seg.className = styles.seg!;
    this.el.appendChild(this.seg);

    this.copyBtn = document.createElement('button');
    this.copyBtn.type = 'button';
    this.copyBtn.className = `${switchStyles.root!} ${styles.copy!}`;
    if (opts.testidPrefix) this.copyBtn.dataset.testid = `bank-${opts.testidPrefix}-copy`;
    this.copyBtn.textContent = 'Copy';
    this.copyBtn.title = 'Copy this bank into another (click Copy, then a slot)';
    this.copyBtn.addEventListener('click', () => this.setArmed(!this.copyArmed));
    this.el.appendChild(this.copyBtn);

    this.renderSegment();
    opts.onEditChange(() => this.render());
    opts.onPlayChange(() => {
      this.syncToPlay();
      this.render();
    });
    opts.onContentChange(() => this.render());
    // A SEPARATE signal from onEditChange on purpose: this one rebuilds DOM, and
    // the edit-bank signal fires on every bank click — rebuilding there would
    // tear the row down mid-gesture (banks.md REQ-a-machine-owns-its-bank-count).
    opts.onBankCountChange?.(() => this.renderSegment());
  }

  /**
   * Build the letter row for the machine's *current* count, plus the grow/shrink
   * arms. Called on construction and whenever the count changes; the arms live
   * inside `.seg` so the banks and their controls read as one unit.
   */
  private renderSegment(): void {
    this.seg.replaceChildren();
    this.btns.length = 0;
    const count = this.opts.bankCount();
    BANK_LABELS.slice(0, count).forEach((label, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = styles.btn!;
      if (this.opts.testidPrefix) b.dataset.testid = `bank-${this.opts.testidPrefix}-${i}`;
      b.innerHTML = `<span class="${styles.letter!}">${label}</span><span class="${styles.dot!}"></span>`;
      b.addEventListener('click', () => {
        // A manual pick of a non-playing bank means editing intent — stop
        // following so the arrangement can't yank the view back next bar.
        if (this._following && i !== this.opts.getPlay()) this.setFollowing(false);
        if (this.copyArmed) {
          this.opts.copy(this.opts.getEdit(), i);
          this.setArmed(false);
          this.opts.setEdit(i);
        } else {
          this.opts.setEdit(i);
        }
      });
      this.btns.push(b);
      this.seg.appendChild(b);
    });

    this.minusBtn = null;
    if (this.opts.removeBank) {
      const minus = this.arm('remove', UI_ICONS.minus!, `Remove bank ${BANK_LABELS[count - 1]}`);
      minus.addEventListener('click', () => this.opts.removeBank?.());
      this.minusBtn = minus;
      this.seg.appendChild(minus);
    }
    if (this.opts.addBank && count < MAX_BANK_COUNT) {
      // Hidden rather than disabled at the ceiling: a dead control at the end of
      // a row reads as broken (ADR-014).
      const plus = this.arm('add', UI_ICONS.plus!, `Add bank ${BANK_LABELS[count]}`);
      plus.addEventListener('click', () => this.opts.addBank?.());
      this.seg.appendChild(plus);
    }
    // The row was rebuilt, so re-apply the state the old nodes carried.
    this.setArmed(this.copyArmed);
    this.render();
  }

  /** One grow/shrink arm: an icon button, labelled by the bank it acts on. */
  private arm(verb: 'add' | 'remove', svg: string, label: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${styles.btn!} ${styles.add!}`;
    if (this.opts.testidPrefix) b.dataset.testid = `bank-${this.opts.testidPrefix}-${verb}`;
    b.innerHTML = svg;
    // The glyph is drawn, so the accessible name has to be written (iconography.md
    // REQ-a-control-glyph-is-inline-svg) — and it names the LETTER, not the sign.
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  }

  private setArmed(on: boolean): void {
    this.copyArmed = on;
    this.copyBtn.classList.toggle('on', on);
    this.el.classList.toggle('copy-armed', on);
  }

  /** Follow state, read-only — the panels gate their rest overlay on it. */
  get following(): boolean {
    return this._following;
  }

  /** Fires on every Follow flip (button toggle or auto-off on a manual bank click). */
  onFollowChange(fn: () => void): () => void {
    return this.followListeners.add(fn);
  }

  /**
   * Public so a panel can declare editing intent on the user's behalf — arming
   * the sequencer's Step Input turns Follow off so the arrangement can't swap
   * the edit bank mid-take (sequencer.md REQ-a-take-is-bank-pinned). Same funnel as a manual bank
   * click, so `onFollowChange` fires either way.
   */
  setFollowing(on: boolean): void {
    this._following = on;
    this.followBtn.classList.toggle('on', on);
    if (on) this.syncToPlay(); // jump to the playing bank at once, not next bar
    this.followListeners.emit();
  }

  /** While following, keep the edit bank on the play bank. */
  private syncToPlay(): void {
    if (!this._following) return;
    const play = this.opts.getPlay();
    if (play !== this.opts.getEdit()) this.opts.setEdit(play);
  }

  private render(): void {
    const edit = this.opts.getEdit();
    const play = this.opts.getPlay();
    // A resting lane plays no bank, so the red "now-playing" dot misreads — a
    // root class recolours it amber via CSS (arrangement-rest.md REQ-resting-bank-bar-marks-itself). render()
    // re-runs on onPlayChange (= arrangement.onChange), which fires when resting flips.
    this.el.classList.toggle('resting', this.opts.resting?.() ?? false);
    this.btns.forEach((b, i) => {
      b.classList.toggle('active', i === edit);
      b.classList.toggle('playing', i === play);
      b.classList.toggle('filled', this.opts.hasContent(i));
    });
    // The − arm's availability depends on CONTENT and on the chain, not only on
    // the count — so it is refreshed here, with the dots, rather than only when
    // the row is rebuilt. Painting a step into the top bank must disable it on
    // the same repaint that lights its dot (banks.md REQ-a-bank-is-removed-only-when-unused).
    if (this.minusBtn) {
      const blocked = this.opts.removeBlockedBy?.() ?? null;
      const label = blocked ?? `Remove bank ${BANK_LABELS[this.opts.bankCount() - 1]}`;
      this.minusBtn.disabled = blocked !== null;
      this.minusBtn.title = label;
      // The accessible name moves WITH the tooltip: a title is not announced, so
      // leaving the aria-label at "Remove bank E" is the one reader that never
      // hears the reason `removeBlockedBy` returns a string in order to give
      // (iconography.md REQ-a-control-glyph-is-inline-svg).
      this.minusBtn.setAttribute('aria-label', label);
    }
  }
}
