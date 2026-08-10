import { ListenerSet } from '../../utils/listeners';
import layout from '../styles/layout.module.css';

/** One page of a tabbed panel. `id` is the testid suffix, not a param. */
export interface PanelTabPage {
  id: string;
  label: string;
  content: HTMLElement;
}

export interface PanelTabsOptions {
  /**
   * Testid namespace: `ptab-<prefix>-<pageId>` / `ppage-<prefix>-<pageId>`
   * (testids.md REQ-2). Required, because the un-namespaced `tab-<id>` belongs
   * to `TabContainer` and is anchored by e2e specs, the tour and `showTab`.
   */
  prefix: string;
  pages: PanelTabPage[];
  /** Defaults to the first page. */
  initialId?: string;
}

export interface PanelTabs {
  /** The strip. Place it in the panel's title row. */
  readonly bar: HTMLElement;
  /** The page stack. Place it where the panel body goes. */
  readonly body: HTMLElement;
  readonly activeId: string;
  activate(id: string): void;
  setLit(id: string, on: boolean): void;
  onChange(fn: (id: string) => void): () => void;
  destroy(): void;
}

/**
 * A tab strip that lives **inside an existing panel's title row**, paging that
 * one panel's body (panel-tabs.md).
 *
 * Not `TabContainer`: that one's `el` is a `.root` carrying its own background,
 * border and shadow — a whole panel — so nesting it inside a `layout.panel`
 * would double-frame it, and its tab metrics (`padding: 8px 18px`) overflow an
 * 8-column faceplate cell. What was missing was a **decomposed** strip, which is
 * why this returns `bar` and `body` separately for the caller to place.
 *
 * The strip **is** the panel's header — it replaces the title rather than
 * sitting beside it, and keeps a plain header's height so a tabbed panel lines
 * up with its untabbed neighbours (REQ-9). The active tab therefore wears the
 * panel-title look and, like it, declares no `font-family` — which is also what
 * keeps this component off the `tests/ui/typography.test.ts` serif allowlist
 * (REQ-4).
 *
 * Which page is showing is **session-only view state** — never a param, never
 * persisted (REQ-2).
 */
export function createPanelTabs(opts: PanelTabsOptions): PanelTabs {
  const listeners = new ListenerSet<[string]>();
  const buttons = new Map<string, HTMLButtonElement>();
  const shells = new Map<string, HTMLElement>();
  let active = '';

  const bar = document.createElement('div');
  bar.className = layout.panelTabs!;

  const body = document.createElement('div');
  body.className = layout.panelPages!;

  const activate = (id: string): void => {
    if (active === id || !shells.has(id)) return;
    active = id;
    for (const [k, b] of buttons) b.classList.toggle('active', k === id);
    // Every page stays mounted and stays subscribed, so the hidden one is
    // already repainted when a song or preset load lands (REQ-5).
    for (const [k, s] of shells) s.classList.toggle('visible', k === id);
    listeners.emit(id);
  };

  for (const page of opts.pages) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = layout.panelTab!;
    b.dataset.testid = `ptab-${opts.prefix}-${page.id}`;
    b.title = `Show the ${page.label} page`;
    // The lamp is a separate span so setLit can repaint it without textContent
    // wiping the label — the same reason TabContainer splits its LED out. It is
    // positioned out of flow, so it cannot pull the label off centre.
    const lamp = document.createElement('span');
    lamp.className = layout.panelTabLamp!;
    const text = document.createElement('span');
    text.textContent = page.label;
    b.append(lamp, text);
    b.addEventListener('click', () => activate(page.id));
    bar.appendChild(b);
    buttons.set(page.id, b);

    const shell = document.createElement('div');
    shell.className = layout.panelPage!;
    shell.dataset.testid = `ppage-${opts.prefix}-${page.id}`;
    shell.appendChild(page.content);
    body.appendChild(shell);
    shells.set(page.id, shell);
  }

  activate(opts.initialId ?? opts.pages[0]?.id ?? '');

  return {
    bar,
    body,
    get activeId() { return active; },
    activate,
    /**
     * Light a tab whose page is doing something the user cannot see (REQ-6).
     * The component paints; the caller decides what counts as active.
     */
    setLit(id: string, on: boolean): void {
      const b = buttons.get(id);
      if (!b) return;
      // A class, not a hashed module class, so a jsdom test can read it —
      // CSS Modules resolve to undefined under Vitest.
      b.classList.toggle('lit', on);
      const label = b.lastElementChild?.textContent ?? id;
      b.setAttribute('aria-label', on ? `${label} — active` : label);
    },
    onChange(fn: (id: string) => void): () => void {
      return listeners.add(fn);
    },
    destroy(): void {
      buttons.clear();
      shells.clear();
    },
  };
}
