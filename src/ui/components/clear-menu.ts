import styles from '../styles/dropdown.module.css';
import switchStyles from '../styles/switch.module.css';

/**
 * The `Clear ▾` header control — `specs/features/step-grid-editing.md` REQ-6.
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
export interface ClearMenuOptions {
  /** Lane name — namespaces the testids (`clear-drum`, `clear-drum-bank`, …). */
  lane: string;
  /** Bank letter for the item label, read at open time (it changes under us). */
  bankLabel(): string;
  onClearBank(): void;
  /** Row-scoped clear (drum track / sampler slot). Omit on single-row grids. */
  rowLabel?: () => string;
  onClearRow?: () => void;
}

export function createClearMenu(opts: ClearMenuOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = `${styles.root!} dropdown`;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = switchStyles.root!;
  toggle.dataset.testid = `clear-${opts.lane}`;
  toggle.textContent = 'Clear ▾';
  toggle.title = 'Clear this bank — or just the selected row. Undoable.';
  root.appendChild(toggle);

  const menu = document.createElement('div');
  menu.className = styles.menu!;
  root.appendChild(menu);

  let open = false;

  const item = (testId: string, run: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = styles.option!;
    b.dataset.testid = testId;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(false);
      run();
    });
    menu.appendChild(b);
    return b;
  };

  const rowItem = opts.onClearRow
    ? item(`clear-${opts.lane}-row`, opts.onClearRow)
    : null;
  const bankItem = item(`clear-${opts.lane}-bank`, opts.onClearBank);

  /**
   * The menu is `position: fixed` so it escapes the panel's stacking and
   * overflow contexts; anchor it to the toggle and flip up near the bottom edge
   * (the same rule `Dropdown.position` follows).
   */
  const position = (): void => {
    const r = toggle.getBoundingClientRect();
    const s = menu.style;
    s.minWidth = `${r.width}px`;
    s.left = `${r.left}px`;
    const mh = menu.offsetHeight;
    const flipUp = r.bottom + 6 + mh > window.innerHeight && r.top - 6 - mh > 0;
    s.top = `${flipUp ? r.top - 6 - mh : r.bottom + 6}px`;
  };

  function setOpen(o: boolean): void {
    if (open === o) return;
    open = o;
    root.classList.toggle('open', o);
    if (!o) return;
    // Labels are built at open time: the edit bank and the selected row both
    // move under us, and a stale "Clear A" on bank C would be a lie.
    if (rowItem && opts.rowLabel) rowItem.textContent = `Clear ${opts.rowLabel()}`;
    bankItem.textContent = `Clear bank ${opts.bankLabel()}`;
    position();
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  document.addEventListener('click', (e) => {
    if (open && !root.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') setOpen(false);
  });

  return root;
}
