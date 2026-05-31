import styles from '../styles/dropdown.module.css';

/**
 * Vintage-styled dropdown. Native `<select>` can't have its open menu
 * cross-browser-styled, so this is a button + absolute-positioned popover.
 */
export class Dropdown {
  readonly el: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private options: string[] = [];
  private _value = '';
  private listener: ((v: string) => void) | null = null;
  private open = false;

  constructor(options: string[], initial?: string) {
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

    this.setOptions(options);
    if (initial !== undefined) this.setValue(initial);

    document.addEventListener('click', this.onDocClick);
    document.addEventListener('keydown', this.onKey);
  }

  setOptions(options: string[]): void {
    this.options = [...options];
    this.menu.innerHTML = '';
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
      this.menu.appendChild(item);
    }
    if (!options.includes(this._value) && options.length > 0) {
      this._value = options[0]!;
    }
    this.renderToggle();
  }

  setValue(v: string): void {
    if (this._value === v) return;
    this._value = v;
    this.renderToggle();
    for (const child of Array.from(this.menu.children) as HTMLElement[]) {
      child.classList.toggle('active', child.textContent === v);
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
      this.position();
      window.addEventListener('scroll', this.onReposition, true);
      window.addEventListener('resize', this.onReposition);
    } else {
      window.removeEventListener('scroll', this.onReposition, true);
      window.removeEventListener('resize', this.onReposition);
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
    const mh = this.menu.offsetHeight; // measurable: `.open` already set display:block
    const flipUp = r.bottom + 6 + mh > window.innerHeight && r.top - 6 - mh > 0;
    s.top = `${flipUp ? r.top - 6 - mh : r.bottom + 6}px`;
  }

  private onDocClick = (e: Event): void => {
    if (!this.open) return;
    if (this.el.contains(e.target as Node)) return;
    this.setOpen(false);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (!this.open) return;
    if (e.key === 'Escape') this.setOpen(false);
  };
}
