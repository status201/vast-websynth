import styles from '../styles/tabs.module.css';
import { createCollapseToggle } from './collapse-toggle';
import type { MachineState } from '../machine-status';

export interface Tab {
  id: string;
  label: string;
  content: HTMLElement;
  /** Show a machine status LED before the label (machine-status.md REQ-3). */
  indicator?: boolean;
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
  private leds = new Map<string, HTMLElement>();
  private labels = new Map<string, string>();
  private expand?: () => void;

  constructor(tabs: Tab[], initialId?: string, opts?: TabOptions) {
    this.el = document.createElement('div');
    this.el.className = styles.root!;

    this.tabBar = document.createElement('div');
    this.tabBar.className = styles.bar!;
    this.el.appendChild(this.tabBar);

    this.body = document.createElement('div');
    this.body.className = styles.body!;
    this.el.appendChild(this.body);

    for (const t of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = styles.tab!;
      b.dataset.testid = `tab-${t.id}`;
      if (t.indicator) {
        // Status LED + label in spans, so setIndicator can repaint the dot
        // without textContent wiping it (cf. StepButton's .label).
        const led = document.createElement('span');
        led.className = styles.led!;
        const label = document.createElement('span');
        label.textContent = t.label;
        b.append(led, label);
        this.leds.set(t.id, led);
        this.labels.set(t.id, t.label);
      } else {
        b.textContent = t.label;
      }
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
      shell.className = styles.content!;
      shell.dataset.tabId = t.id;
      shell.dataset.testid = `panel-${t.id}`;
      shell.appendChild(t.content);
      this.body.appendChild(shell);
    }

    if (opts?.collapsibleStoreKey) {
      // The whole tab bar toggles collapse, EXCEPT clicks on a tab button:
      // those keep their own expand-and-activate behaviour and never collapse.
      const c = createCollapseToggle(this.el, opts.collapsibleStoreKey, {
        defaultCollapsed: opts.collapsedByDefault,
        trigger: this.tabBar,
        ignoreSelector: `.${styles.tab!}`,
      });
      this.expand = c.expand;
      this.tabBar.appendChild(c.el);
    }

    this.activate(initialId ?? tabs[0]?.id ?? '');
  }

  /** The active tab's id (e.g. Ctrl+Z scoping — pattern-undo.md REQ-10). */
  get activeId(): string {
    return this.active;
  }

  activate(id: string): void {
    if (this.active === id) return;
    this.active = id;
    for (const [k, b] of this.buttons) b.classList.toggle('active', k === id);
    for (const c of Array.from(this.body.children) as HTMLElement[]) {
      c.classList.toggle('visible', c.dataset.tabId === id);
    }
  }

  /**
   * Expand-then-activate — what a real tab click does (machine-status.md REQ-7).
   * External callers should prefer this over `activate`, which leaves a
   * collapsed bar collapsed and so appears to do nothing.
   */
  reveal(id: string): void {
    this.expand?.();
    this.activate(id);
  }

  /**
   * Paint a tab's status LED. No-op for tabs registered without `indicator`.
   * Also writes the state into the button's aria-label/title so it is never
   * conveyed by colour alone (machine-status.md REQ-4).
   */
  setIndicator(id: string, state: MachineState): void {
    const led = this.leds.get(id);
    if (!led) return;
    // The state rides on a data attribute, not a class: CSS styles it via
    // [data-state=…] and tests can read it without knowing the hashed module
    // class name (CSS Modules resolve to undefined under Vitest).
    led.dataset.state = state;
    const b = this.buttons.get(id);
    if (b) {
      const desc = `${this.labels.get(id) ?? id} — ${state}`;
      b.setAttribute('aria-label', desc);
      b.title = desc;
    }
  }
}
