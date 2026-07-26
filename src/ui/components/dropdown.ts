import styles from '../styles/dropdown.module.css';

/**
 * Option count at which the menu grows a live filter row (dropdown.md REQ-7).
 * Well above the ~9-10 rows the 280px menu fits: a list that scrolls a little
 * keeps its zero-chrome look, and only the genuinely long ones (the ~198 bus
 * param ids behind the XY/Motion assign pickers) pay for the extra row.
 */
const FILTER_MIN_OPTIONS = 20;

/**
 * Magnifier. Local to this component rather than in `header-icons.ts` — that
 * module is the header's utility buttons, and its `svg.hdr-icon` CSS is sized
 * for 15px header slots. No inline colour: stroke comes from `currentColor`.
 */
const SEARCH_ICON =
  `<svg class="${styles.searchIcon!}" viewBox="0 0 16 16" aria-hidden="true">` +
  '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 L14 14"/>' +
  '</svg>';

export interface DropdownOptions {
  /** Force the filter row on/off; omitted = auto by option count (REQ-7). */
  filter?: boolean;
}

/**
 * Vintage-styled dropdown. Native `<select>` can't have its open menu
 * cross-browser-styled, so this is a button + absolute-positioned popover.
 */
export class Dropdown {
  readonly el: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly menu: HTMLElement;
  /** The scrolling option box. Separate from `menu` so the filter row can sit
   *  pinned above it and survive `setOptions` (REQ-7). */
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private filterRow: HTMLElement | null = null;
  private filterInput: HTMLInputElement | null = null;
  private options: string[] = [];
  private _value = '';
  private listener: ((v: string) => void) | null = null;
  private open = false;
  private readonly forceFilter: boolean | undefined;

  constructor(options: string[], initial?: string, opts?: DropdownOptions) {
    this.forceFilter = opts?.filter;

    this.el = document.createElement('div');
    this.el.className = `${styles.root!} dropdown`;

    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = styles.toggle!;
    this.toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setOpen(!this.open);
    });
    this.el.appendChild(this.toggle);

    this.menu = document.createElement('div');
    this.menu.className = styles.menu!;
    this.el.appendChild(this.menu);

    this.list = document.createElement('div');
    this.list.className = styles.list!;
    this.menu.appendChild(this.list);

    // Kept out of `.list` so a filter that matches nothing still leaves
    // something to read instead of an empty box.
    this.empty = document.createElement('div');
    this.empty.className = styles.empty!;
    this.empty.textContent = 'No match';
    this.empty.hidden = true;
    this.menu.appendChild(this.empty);

    this.setOptions(options);
    if (initial !== undefined) this.setValue(initial);

    document.addEventListener('click', this.onDocClick);
    document.addEventListener('keydown', this.onKey);
  }

  setOptions(options: string[]): void {
    this.options = [...options];
    // The threshold can be crossed in both directions (`Presets.list()` grows as
    // the user saves), so the row is (re)decided on every call.
    this.ensureFilter(this.forceFilter ?? options.length >= FILTER_MIN_OPTIONS);
    this.list.innerHTML = '';
    for (const opt of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = styles.option!;
      item.textContent = opt;
      if (opt === this._value) item.classList.add('active');
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setValue(opt);
        this.setOpen(false);
        this.listener?.(opt);
      });
      this.list.appendChild(item);
    }
    if (!options.includes(this._value) && options.length > 0) {
      this._value = options[0]!;
    }
    this.resetFilter();
    this.renderToggle();
  }

  setValue(v: string): void {
    if (this._value === v) return;
    this._value = v;
    this.renderToggle();
    for (const item of this.optionEls()) {
      item.classList.toggle('active', item.textContent === v);
    }
  }

  get value(): string { return this._value; }

  onChange(cb: (v: string) => void): void { this.listener = cb; }

  destroy(): void {
    document.removeEventListener('click', this.onDocClick);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('scroll', this.onReposition, true);
    window.removeEventListener('resize', this.onReposition);
  }

  private optionEls(): HTMLButtonElement[] {
    return [...this.list.querySelectorAll<HTMLButtonElement>(`.${styles.option!}`)];
  }

  /** Build or drop the filter row (REQ-7). Never touches `.list`. */
  private ensureFilter(want: boolean): void {
    if (want === (this.filterRow !== null)) return;
    if (!want) {
      this.filterRow?.remove();
      this.filterRow = null;
      this.filterInput = null;
      return;
    }
    const row = document.createElement('div');
    row.className = styles.filterRow!;
    row.innerHTML = SEARCH_ICON;
    // Deliberately not a <button> anywhere in here: consumers select the toggle
    // as the dropdown's first button (REQ-7).
    const input = document.createElement('input');
    input.type = 'text';
    input.className = styles.filterInput!;
    input.placeholder = 'Filter…';
    input.setAttribute('aria-label', 'Filter options');
    input.dataset.testid = 'dropdown-filter';
    // A stray click in the field must not reach the toggle or the document
    // outside-click handler.
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('input', () => this.applyFilter(input.value));
    input.addEventListener('keydown', this.onFilterKey);
    row.appendChild(input);
    // Above the option box, so it stays put while the options scroll.
    this.menu.insertBefore(row, this.list);
    this.filterRow = row;
    this.filterInput = input;
  }

  /** Clear the query and show every option. */
  private resetFilter(): void {
    if (this.filterInput) this.filterInput.value = '';
    this.applyFilter('');
  }

  private applyFilter(query: string): void {
    const q = query.trim().toLowerCase();
    let visible = 0;
    for (const item of this.optionEls()) {
      const hit = q === '' || (item.textContent ?? '').toLowerCase().includes(q);
      item.hidden = !hit;
      if (hit) visible++;
    }
    this.empty.hidden = visible > 0 || this.options.length === 0;
  }

  /** The options a filter has not hidden — what the arrow keys walk (REQ-8). */
  private visibleOptions(): HTMLButtonElement[] {
    return this.optionEls().filter((o) => !o.hidden);
  }

  private focusOption(o: HTMLButtonElement): void {
    o.scrollIntoView?.({ block: 'nearest' }); // optional: jsdom has no layout
    o.focus({ preventScroll: true });
  }

  private readonly onFilterKey = (e: KeyboardEvent): void => {
    // Escape and the arrow keys are left to bubble to `onKey`, which owns
    // closing (REQ-3) and list navigation (REQ-8) for the whole component.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    this.visibleOptions()[0]?.click();
  };

  private renderToggle(): void {
    this.toggle.innerHTML = '';
    const label = document.createElement('span');
    label.className = styles.label!;
    label.textContent = this._value;
    const caret = document.createElement('span');
    caret.className = styles.caret!;
    caret.textContent = '▾';
    this.toggle.appendChild(label);
    this.toggle.appendChild(caret);
  }

  private setOpen(o: boolean): void {
    if (this.open === o) return;
    this.open = o;
    this.el.classList.toggle('open', o);
    if (o) {
      // Always open on the whole list — a persisted query would be invisible
      // state hiding options (REQ-7, ADR-014 law 5).
      this.resetFilter();
      this.position();
      window.addEventListener('scroll', this.onReposition, true);
      window.addEventListener('resize', this.onReposition);
      // Land on the current selection instead of the top of a long list
      // (specs/features/dropdown.md REQ-5). Focusing a native <button> makes
      // Enter select it; preventScroll keeps the page itself still. The
      // optional call guards jsdom, which lacks scrollIntoView.
      const active =
        this.list.querySelector<HTMLButtonElement>(`.${styles.option!}.active`) ??
        this.list.querySelector<HTMLButtonElement>(`.${styles.option!}`);
      active?.scrollIntoView?.({ block: 'nearest' });
      // With a filter, typing is the point of opening — focus the field and let
      // the scroll above still show where the current value sits (REQ-5).
      if (this.filterInput) this.filterInput.focus({ preventScroll: true });
      else active?.focus({ preventScroll: true });
    } else {
      window.removeEventListener('scroll', this.onReposition, true);
      window.removeEventListener('resize', this.onReposition);
      // Hand focus back to the toggle so Escape/selection doesn't drop the
      // keyboard user into a display:none menu (REQ-6).
      if (this.el.contains(document.activeElement)) this.toggle.focus();
    }
  }

  private onReposition = (): void => {
    if (this.open) this.position();
  };

  /**
   * The menu is `position: fixed` so it escapes every stacking context and
   * `overflow` ancestor (panels, tab scrollers). Anchor it to the toggle's
   * viewport rect, flipping above when it would overflow the bottom edge.
   */
  private position(): void {
    const r = this.toggle.getBoundingClientRect();
    const s = this.menu.style;
    s.minWidth = `${r.width}px`;
    s.left = `${r.left}px`;
    const mh = this.menu.offsetHeight; // measurable: `.open` already set display:flex
    const flipUp = r.bottom + 6 + mh > window.innerHeight && r.top - 6 - mh > 0;
    s.top = `${flipUp ? r.top - 6 - mh : r.bottom + 6}px`;
  }

  private onDocClick = (e: Event): void => {
    if (!this.open) return;
    if (this.el.contains(e.target as Node)) return;
    this.setOpen(false);
  };

  /**
   * Escape closes (REQ-3); Up/Down/Home/End walk the options (REQ-8). One
   * document-level handler serves both the filter input and a focused option,
   * because the keydown bubbles here from either — so there is a single
   * definition of "the next option", not one per focus target.
   */
  private onKey = (e: KeyboardEvent): void => {
    if (!this.open) return;
    if (e.key === 'Escape') { this.setOpen(false); return; }

    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;
    // Ours now: preventDefault stops the menu scrolling out from under the
    // focus move, and stopPropagation keeps the key off `installShortcuts`
    // (which listens on window and would seek the transport on Home).
    e.preventDefault();
    e.stopPropagation();

    const items = this.visibleOptions();
    if (items.length === 0) return;
    if (e.key === 'Home') { this.focusOption(items[0]!); return; }
    if (e.key === 'End') { this.focusOption(items[items.length - 1]!); return; }

    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) {
      // Focus is on the filter field (or the toggle): enter the list from the
      // end the arrow points at.
      this.focusOption(step > 0 ? items[0]! : items[items.length - 1]!);
      return;
    }
    const next = at + step;
    if (next < 0 || next >= items.length) {
      // Past an end. With a filter, fall back into the field — that is where
      // the user narrows the list, so it belongs in the cycle. Without one,
      // wrap around.
      if (this.filterInput) this.filterInput.focus({ preventScroll: true });
      else this.focusOption(next < 0 ? items[items.length - 1]! : items[0]!);
      return;
    }
    this.focusOption(items[next]!);
  };
}
