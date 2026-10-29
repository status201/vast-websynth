import styles from '../styles/dropdown.module.css';
import switchStyles from '../styles/switch.module.css';
import { iconLabel } from './ui-icons';
import { anchorMenu, dismissMenu, menuClosed, menuOpened } from './menu-anchor';

/**
 * The `Clear ▾` header control — `specs/features/step-grid-editing.md` REQ-clear-menu-clears-in-bulk.
 * Sits beside the machine's Undo button, which is its natural sibling: both
 * undo work, one at a time and one bank at a time.
 *
 * No confirmation dialog. The items say exactly what they destroy and the
 * caller pairs them with a toast carrying Undo, which ADR-014 law 3 prefers
 * over interrupting every correct use to guard the rare wrong one.
 *
 * It borrows `dropdown.module.css` for looks but is deliberately NOT a
 * `Dropdown`: that component selects a *value* (it renders the selection in its
 * toggle and marks an option `.active`), while this fires *actions* and has no
 * state to show.
 */
/** One row-scoped clear offered by the menu. */
export interface ClearMenuRow {
  label: string;
  run(): void;
}

export interface ClearMenuOptions {
  /** Lane name — namespaces the testids (`clear-drum`, `clear-drum-bank`, …). */
  lane: string;
  /** Bank letter for the item label, read at open time (it changes under us). */
  bankLabel(): string;
  onClearBank(): void;
  /**
   * Row-scoped clears, resolved **at open time**. A machine with a selection
   * cursor returns the one selected row; a machine without one (Motion) returns
   * every lane worth offering. Omit entirely on single-row grids.
   */
  rows?: () => ClearMenuRow[];
  /**
   * Rotate the bank one cell (step-grid-editing.md REQ-shift-rotates-the-played-window):
   * `-1` earlier, `1` later. Omitted on a lane that cannot shift (Motion).
   */
  onShift?: (dir: 1 | -1) => void;
}

export function createClearMenu(opts: ClearMenuOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = `${styles.root!} dropdown`;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = switchStyles.root!;
  toggle.dataset.testid = `clear-${opts.lane}`;
  toggle.innerHTML = iconLabel('caretDown', 'Clear', 'after');
  toggle.title = opts.onShift
    ? 'Clear or shift this bank — or clear just the selected row. Undoable.'
    : 'Clear this bank — or just the selected row. Undoable.';
  root.appendChild(toggle);

  const menu = document.createElement('div');
  menu.className = styles.menu!;
  root.appendChild(menu);

  let open = false;

  const item = (testId: string, label: string, run: () => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = styles.option!;
    b.dataset.testid = testId;
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(false);
      run();
    });
    menu.appendChild(b);
  };

  function setOpen(o: boolean): void {
    if (open === o) return;
    open = o;
    root.classList.toggle('open', o);
    // One menu at a time (dropdown.md REQ-one-menu-is-open-at-a-time).
    if (!o) { menuClosed(root); return; }
    menuOpened(root, () => setOpen(false));
    // The whole menu is rebuilt on every open: the edit bank, the selected row
    // and (on Motion) which lanes even have content all move under us. A stale
    // "Clear A" on bank C, or a row that has since emptied, would be a lie.
    menu.innerHTML = '';
    (opts.rows?.() ?? []).forEach((row, i) => {
      item(`clear-${opts.lane}-row-${i}`, `Clear ${row.label}`, row.run);
    });
    item(`clear-${opts.lane}-bank`, `Clear bank ${opts.bankLabel()}`, opts.onClearBank);
    const shift = opts.onShift;
    if (shift) {
      item(`clear-${opts.lane}-shift-left`, `Shift bank ${opts.bankLabel()} left`, () => shift(-1));
      item(`clear-${opts.lane}-shift-right`, `Shift bank ${opts.bankLabel()} right`, () => shift(1));
    }
    // Fixed, so it escapes the panel's stacking and overflow contexts
    // (dropdown.md REQ-every-fixed-menu-shares-one-anchor-and-dismiss).
    anchorMenu(toggle, menu, 'toggle');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  dismissMenu(root, () => open, () => setOpen(false));

  return root;
}
