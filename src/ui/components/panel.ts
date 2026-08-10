import styles from '../styles/layout.module.css';
import { createPanelTabs, type PanelTabs } from './panel-tabs';

/** One page of a tabbed panel, built in place like a plain panel's body. */
export interface PanelPageSpec {
  id: string;
  /** Shown on the tab. This is the panel's heading now, so name it in full. */
  label: string;
  build(body: HTMLElement): void;
}

export interface TabbedPanelOptions {
  /** Testid namespace for the strip (panel-tabs.md REQ-3). */
  prefix: string;
  /** Help topic id — lands on the tab row, never on a tab (REQ-7). */
  help?: string;
  pages: PanelPageSpec[];
}

/** The bare faceplate panel box. Both forms fill it with a header + a body. */
function panelRoot(): HTMLElement {
  const el = document.createElement('div');
  el.className = styles.panel!;
  return el;
}

function panelBody(): HTMLElement {
  const body = document.createElement('div');
  body.className = styles.panelBody!;
  return body;
}

/**
 * A synth faceplate panel: title over a body of controls.
 *
 * Signature preserved from the private helper this replaced, so the seven
 * untabbed panels in `app.ts` are unchanged at their call sites.
 */
export function createPanel(
  title: string,
  build: (body: HTMLElement) => void,
  helpId?: string,
): HTMLElement {
  const el = panelRoot();

  const t = document.createElement('div');
  t.className = styles.panelTitle!;
  t.textContent = title;
  if (helpId) t.dataset.help = helpId;
  el.appendChild(t);

  const body = panelBody();
  build(body);
  el.appendChild(body);
  return el;
}

/**
 * A faceplate panel whose body is paged by tabs — the answer to "this needs
 * another panel" on a grid with no columns left (panel-tabs.md, lfo.md REQ-15).
 *
 * The strip **replaces** the title rather than sitting beside it: each tab
 * names its own page, so a separate heading would only repeat them, and the row
 * keeps a plain panel's header height so a tabbed panel still lines up with its
 * untabbed neighbours (panel-tabs.md REQ-9).
 *
 * `data-help` therefore lands on the tab row — still not on a tab button, so the
 * ⓘ badge neither moves nor disappears when the page changes (REQ-7).
 *
 * Each page's `build` runs before the strip activates, so the first paint sees a
 * fully built stack.
 */
export function createTabbedPanel(opts: TabbedPanelOptions): { el: HTMLElement; tabs: PanelTabs } {
  const el = panelRoot();

  const pages = opts.pages.map((p) => {
    const content = panelBody();
    p.build(content);
    return { id: p.id, label: p.label, content };
  });

  const tabs = createPanelTabs({ prefix: opts.prefix, pages });
  if (opts.help) tabs.bar.dataset.help = opts.help;
  el.append(tabs.bar, tabs.body);

  return { el, tabs };
}
