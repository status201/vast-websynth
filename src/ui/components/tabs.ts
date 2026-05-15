export interface Tab {
  id: string;
  label: string;
  content: HTMLElement;
}

export class TabContainer {
  readonly el: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly body: HTMLElement;
  private active = '';
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(tabs: Tab[], initialId?: string) {
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
      b.addEventListener('click', () => this.activate(t.id));
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
