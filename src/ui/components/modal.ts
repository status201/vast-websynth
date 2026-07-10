import styles from '../styles/modal.module.css';

/**
 * Reusable modal dialog — the backdrop / card / title / Escape /
 * backdrop-click / fade lifecycle that was hand-rolled in `about.ts` and the
 * start modal. Single-use: construct, `open()`, `close()` (a fresh instance
 * per appearance, which is how the record-sound modal is used).
 *
 * Pass `cardClass` for a width/layout variant.
 */
export interface ModalOptions {
  title: string;
  /** Extra class on the card (e.g. 'rec-modal' for a wider variant). */
  cardClass?: string;
  /** Called exactly once when the modal closes (for caller cleanup). */
  onClose?: () => void;
  /**
   * Whether a click on the backdrop closes the modal. Default `true`. Set
   * `false` for multi-step flows where a stray outside click would discard
   * progress (e.g. the WiFi pair wizard) — pair it with an explicit Close
   * button; Escape still closes.
   */
  dismissOnBackdrop?: boolean;
}

export class Modal {
  /** Caller appends its content here. */
  readonly body: HTMLElement;

  private readonly backdrop: HTMLElement;
  private readonly onCloseCb?: () => void;
  private closeTimer: number | undefined;
  private opened = false;
  private closed = false;

  /** Expose class names so about.ts etc. can build consistent markup. */
  static get backdropClass(): string { return styles.backdrop!; }
  static get cardClass(): string { return styles.card!; }
  static get cardWideClass(): string { return styles.cardWide!; }
  static get titleClass(): string { return styles.title!; }
  static get bodyClass(): string { return styles.body!; }
  static get tagClass(): string { return styles.tag!; }
  static get metaClass(): string { return styles.meta!; }
  static get secClass(): string { return styles.sec!; }
  static get keysClass(): string { return styles.keys!; }
  static get keyClass(): string { return styles.key!; }
  static get actClass(): string { return styles.act!; }
  static get closeBtnClass(): string { return styles.closeBtn!; }

  constructor(opts: ModalOptions) {
    this.onCloseCb = opts.onClose;

    this.backdrop = document.createElement('div');
    this.backdrop.className = `${styles.backdrop!} hidden`;
    if (opts.dismissOnBackdrop !== false) {
      this.backdrop.addEventListener('pointerdown', (e) => {
        if (e.target === this.backdrop) this.close();
      });
    }

    const card = document.createElement('div');
    card.className = opts.cardClass ? `${styles.card!} ${opts.cardClass}` : styles.card!;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', opts.title);

    const title = document.createElement('div');
    title.className = styles.title!;
    title.textContent = opts.title;

    this.body = document.createElement('div');
    this.body.className = styles.body!;

    card.appendChild(title);
    card.appendChild(this.body);
    this.backdrop.appendChild(card);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // Beat the global Escape→panic handler in shortcuts.ts.
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
    }
  };

  open(): void {
    if (this.opened) return;
    this.opened = true;
    document.body.appendChild(this.backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void this.backdrop.offsetWidth;
    this.backdrop.classList.remove('hidden');
    window.addEventListener('keydown', this.onKey, true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKey, true);
    this.backdrop.classList.add('hidden');
    const el = this.backdrop;
    this.closeTimer = window.setTimeout(() => el.remove(), 200);
    this.onCloseCb?.();
  }
}
