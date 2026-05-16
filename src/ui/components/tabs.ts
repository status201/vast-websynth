import { createCollapseToggle } from './collapse-toggle';

export interface Tab {
  id: string;
  label: string;
  content: HTMLElement;
}

export interface TabOptions {
  /** If set, adds a fold chevron to the tab bar; state persists under this key. */
  collapsibleStoreKey?: string;
  /** Initial collapsed state when no stored preference exists (see CollapseToggleOptions). */
  collapsedByDefault?: () => boolean;
}

export class TabContainer {
  readonly el: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly body: HTMLElement;
  private active = '';
  private buttons = new Map<string, HTMLButtonElement>();
  private expand?: () => void;

  constructor(tabs: Tab[], initialId?: string, opts?: TabOptions) {
    this.el = document.createElement('div');
    this.el.className = 'tabs';

    this.tabBar = document.createElement('div');
    this.tabBar.className = 'tabs-bar';
    this.el.appendChild(this.tabBar);

    this.body = document.createElement('div');
    this.body.className = 'tabs-body';
    this.el.appendChild(this.body);

    for (const t of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.textContent = t.label;
      // Clicking a tab while collapsed expands first, then activates it.
      b.addEventListener('click', () => {
        this.expand?.();
        this.activate(t.id);
      });
      this.tabBar.appendChild(b);
      this.buttons.set(t.id, b);

      // Wrap content in a shell so visibility toggling doesn't fight the
      // child's own `display` rules.
      const shell = document.createElement('div');
      shell.className = 'tab-content';
      shell.dataset.tabId = t.id;
      shell.appendChild(t.content);
      this.body.appendChild(shell);
    }

    if (opts?.collapsibleStoreKey) {
      // The whole tab bar toggles collapse, EXCEPT clicks on a tab button:
      // those keep their own expand-and-activate behaviour and never collapse.
      const c = createCollapseToggle(this.el, opts.collapsibleStoreKey, {
        defaultCollapsed: opts.collapsedByDefault,
        trigger: this.tabBar,
        ignoreSelector: '.tab',
      });
      this.expand = c.expand;
      this.tabBar.appendChild(c.el);
    }

    this.activate(initialId ?? tabs[0]?.id ?? '');
  }

  activate(id: string): void {
    if (this.active === id) return;
    this.active = id;
    for (const [k, b] of this.buttons) b.classList.toggle('active', k === id);
    for (const c of Array.from(this.body.children) as HTMLElement[]) {
      c.classList.toggle('visible', c.dataset.tabId === id);
    }
  }
}
