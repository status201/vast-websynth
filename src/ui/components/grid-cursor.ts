import { StepButton } from './step-button';

/**
 * The 2-D selection cursor the drum and sampler grids share: exactly one cell
 * carries `StepButton.selectedClass`, and moving it runs the panel's own
 * refresh work (`onMove`).
 */
export class GridCursor {
  private row = 0;
  private col = 0;
  private keyboard = false;

  constructor(
    private readonly cells: readonly (readonly StepButton[])[],
    private readonly onMove: () => void,
  ) {}

  get selRow(): number { return this.row; }
  get selCol(): number { return this.col; }

  set(row: number, col: number): void {
    const prev = this.cells[this.row]?.[this.col]?.el;
    prev?.classList.remove(StepButton.selectedClass);
    if (this.keyboard && prev) prev.tabIndex = -1;
    this.row = row;
    this.col = col;
    const next = this.cells[row]?.[col]?.el;
    next?.classList.add(StepButton.selectedClass);
    // The one Tab stop follows the selection, however it moved (REQ-a-trigger-grid-is-reachable-by-keyboard).
    if (this.keyboard && next) next.tabIndex = 0;
    this.onMove();
  }

  /**
   * Make the grid keyboard-reachable (step-grid-editing.md
   * REQ-a-trigger-grid-is-reachable-by-keyboard): one Tab stop — the selected
   * cell — arrows to move within the played window, Enter to toggle. Only those
   * keys are consumed; Space, Delete, Shift+arrows and the note keys pass on.
   */
  enableKeyboard(opts: {
    isOn(row: number, col: number): boolean;
    onToggle(row: number, col: number, on: boolean): void;
    /** The lane's played cells — the window the arrows stay inside. */
    cols(): number;
    /** A row's name for the cell's accessible label. */
    rowLabel(row: number): string;
  }): void {
    this.keyboard = true;
    this.cells.forEach((row, r) => row.forEach((sb, c) => {
      sb.el.tabIndex = r === this.row && c === this.col ? 0 : -1;
      sb.el.addEventListener('keydown', (e) => this.onKey(e, opts));
      sb.el.addEventListener('focus', () => this.label(r, c, opts));
    }));
  }

  private label(r: number, c: number, opts: { isOn(r: number, c: number): boolean; rowLabel(r: number): string }): void {
    const el = this.cells[r]?.[c]?.el;
    if (!el) return;
    const text = `${opts.rowLabel(r)}, step ${c + 1}, ${opts.isOn(r, c) ? 'on' : 'off'}`;
    if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-label', text);
  }

  private onKey(
    e: KeyboardEvent,
    opts: {
      isOn(r: number, c: number): boolean;
      onToggle(r: number, c: number, on: boolean): void;
      cols(): number;
      rowLabel(r: number): string;
    },
  ): void {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return; // Shift+arrows seek
    const last = Math.max(0, Math.min(opts.cols(), this.cells[this.row]?.length ?? 1) - 1);
    let r = this.row;
    let c = Math.min(this.col, last);
    switch (e.key) {
      case 'ArrowLeft': c = Math.max(0, c - 1); break;
      case 'ArrowRight': c = Math.min(last, c + 1); break;
      case 'ArrowUp': r = Math.max(0, r - 1); break;
      case 'ArrowDown': r = Math.min(this.cells.length - 1, r + 1); break;
      case 'Home': c = 0; break;
      case 'End': c = last; break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        opts.onToggle(this.row, this.col, !opts.isOn(this.row, this.col));
        this.label(this.row, this.col, opts);
        return;
      default:
        return; // Space, Delete, letters: not ours
    }
    e.preventDefault();
    e.stopPropagation();
    if (r !== this.row || c !== this.col) this.set(r, c);
    this.cells[r]?.[c]?.el.focus();
  }
}
