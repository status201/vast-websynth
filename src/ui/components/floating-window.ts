import styles from '../styles/floating-window.module.css';

/**
 * Reusable **non-modal** floating window — a titled, draggable panel that hovers
 * over the synth with NO backdrop, so the instrument stays interactive while it
 * is open. Sibling of `Modal` (same fade lifecycle) but deliberately drops the
 * backdrop and the Escape binding (a non-modal tool must not steal the panic
 * key). Unlike single-use `Modal`, one instance re-opens: `open()` → `close()` →
 * `open()`. See `specs/features/floating-window.md`.
 */
export interface FloatingWindowOptions {
  title: string;
  /** data-testid on the root element. */
  testId?: string;
  /** Start position in px; defaults to near the top, horizontally centred-ish. */
  initial?: { left: number; top: number };
  /** Extra class on the root (a width/layout variant). */
  windowClass?: string;
  /** Caller-owned control inserted as the title bar's first child (left of the
   *  title). Its pointerdown is stopped so a window drag never starts from it. */
  leading?: HTMLElement;
  /** Called once per close transition (caller cleanup). */
  onClose?: () => void;
}

export class FloatingWindow {
  /** Caller appends its content here. */
  readonly body: HTMLElement;

  private readonly root: HTMLElement;
  private readonly minBtn: HTMLButtonElement;
  private readonly onCloseCb?: () => void;
  private closeTimer: number | undefined;
  private _isOpen = false;
  private _collapsed = false;

  // Drag state.
  private dragging = false;
  private startX = 0;
  private startY = 0;
  private startLeft = 0;
  private startTop = 0;
  private pos: { left: number; top: number };

  /** Expose class names for consistent markup / testing (parity with Modal). */
  static get rootClass(): string { return styles.root!; }
  static get titleBarClass(): string { return styles.titleBar!; }
  static get titleClass(): string { return styles.title!; }
  static get closeBtnClass(): string { return styles.closeBtn!; }
  static get minBtnClass(): string { return styles.minBtn!; }
  static get bodyClass(): string { return styles.body!; }

  constructor(opts: FloatingWindowOptions) {
    this.onCloseCb = opts.onClose;
    this.pos = opts.initial ?? {
      left: Math.max(24, Math.round((typeof window !== 'undefined' ? window.innerWidth : 800) / 2 - 150)),
      top: 96,
    };

    this.root = document.createElement('div');
    this.root.className = opts.windowClass ? `${styles.root!} ${opts.windowClass} hidden` : `${styles.root!} hidden`;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', opts.title);
    if (opts.testId) this.root.dataset.testid = opts.testId;
    this.root.style.left = `${this.pos.left}px`;
    this.root.style.top = `${this.pos.top}px`;

    const bar = document.createElement('div');
    bar.className = styles.titleBar!;
    bar.addEventListener('pointerdown', this.onDragStart);

    // Built-in minimise/restore button — far-left of the title bar, before any
    // caller `leading` control. Collapses the body to leave just the toolbar.
    this.minBtn = document.createElement('button');
    this.minBtn.type = 'button';
    this.minBtn.className = styles.minBtn!;
    // Stop the pointerdown so the title-bar drag never starts from the − button.
    this.minBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.minBtn.addEventListener('click', () => this.toggleCollapsed());
    this.syncMinBtn();

    const title = document.createElement('div');
    title.className = styles.title!;
    title.textContent = opts.title;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = styles.closeBtn!;
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close');
    // Stop the pointerdown so the title-bar drag never starts from the × button.
    closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', () => this.close());

    bar.appendChild(this.minBtn);
    if (opts.leading) {
      // Stop the pointerdown so the title-bar drag never starts from the control.
      opts.leading.addEventListener('pointerdown', (e) => e.stopPropagation());
      bar.appendChild(opts.leading);
    }
    bar.appendChild(title);
    bar.appendChild(closeBtn);

    this.body = document.createElement('div');
    this.body.className = styles.body!;

    this.root.appendChild(bar);
    this.root.appendChild(this.body);
  }

  get isOpen(): boolean { return this._isOpen; }

  get isCollapsed(): boolean { return this._collapsed; }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    // Always reveal expanded — collapse state is ephemeral, so a re-open of an
    // instance kept alive across closes is predictable (body visible).
    this.setCollapsed(false);
    window.clearTimeout(this.closeTimer);
    if (!this.root.isConnected) document.body.appendChild(this.root);
    // Force reflow so the opacity transition runs from the .hidden state.
    void this.root.offsetWidth;
    this.root.classList.remove('hidden');
    // Re-clamp a possibly stale position into the current viewport, then keep it
    // there across resize/orientation changes while open (REQ-8).
    this.clampIntoView();
    window.addEventListener('resize', this.onViewportResize);
    window.addEventListener('orientationchange', this.onViewportResize);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.endDrag();
    window.removeEventListener('resize', this.onViewportResize);
    window.removeEventListener('orientationchange', this.onViewportResize);
    this.root.classList.add('hidden');
    const el = this.root;
    this.closeTimer = window.setTimeout(() => el.remove(), 200);
    this.onCloseCb?.();
  }

  private toggleCollapsed(): void {
    this.setCollapsed(!this._collapsed);
    // Restoring re-grows the body (offsetHeight), which could push it past the
    // bottom edge — re-clamp so a restored window stays in view (REQ-8).
    if (this._isOpen) this.clampIntoView();
  }

  private setCollapsed(collapsed: boolean): void {
    this._collapsed = collapsed;
    this.root.classList.toggle('collapsed', collapsed);
    this.syncMinBtn();
  }

  /** Reflect the current collapse state on the minimise button (glyph + a11y). */
  private syncMinBtn(): void {
    this.minBtn.textContent = this._collapsed ? '+' : '−';
    this.minBtn.setAttribute('aria-expanded', String(!this._collapsed));
    this.minBtn.setAttribute('aria-label', this._collapsed ? 'Restore' : 'Minimise');
  }

  private readonly onDragStart = (e: PointerEvent): void => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    this.dragging = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startLeft = this.pos.left;
    this.startTop = this.pos.top;
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    window.addEventListener('pointercancel', this.onDragEnd);
  };

  private readonly onDragMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.applyClampedPos(this.startLeft + (e.clientX - this.startX), this.startTop + (e.clientY - this.startY));
  };

  /** Store `left`/`top` clamped to the current viewport and write them to the
   *  root. Shared by drag and by the open/resize re-clamp (REQ-8) so the bounds
   *  are identical. */
  private applyClampedPos(left: number, top: number): void {
    const maxLeft = Math.max(0, window.innerWidth - this.root.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - this.root.offsetHeight);
    this.pos.left = clamp(left, 0, maxLeft);
    this.pos.top = clamp(top, 0, maxTop);
    this.root.style.left = `${this.pos.left}px`;
    this.root.style.top = `${this.pos.top}px`;
  }

  /** Re-clamp the current position against the live viewport (REQ-8). */
  private clampIntoView(): void {
    this.applyClampedPos(this.pos.left, this.pos.top);
  }

  private readonly onViewportResize = (): void => {
    if (this._isOpen) this.clampIntoView();
  };

  private readonly onDragEnd = (): void => { this.endDrag(); };

  private endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    window.removeEventListener('pointercancel', this.onDragEnd);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
