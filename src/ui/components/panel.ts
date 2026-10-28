import styles from '../styles/panel.module.css';
import { createPanelTabs, type PanelTabs } from './panel-tabs';

/** One page of a tabbed panel, built in place like a plain panel's body. */
export interface PanelPageSpec {
  id: string;
  /** Shown on the tab. This is the panel's heading now, so name it in full. */
  label: string;
  build(body: HTMLElement): void;
}

export interface TabbedPanelOptions {
  /** Testid namespace for the strip (panel-tabs.md REQ-panel-tab-testids-are-prefixed). */
  prefix: string;
  /** Help topic id — lands on the tab row, never on a tab (REQ-data-help-sits-on-the-tab-row). */
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

/** A knob row in a panel body, in one of the row shapes — `.quad`, `.quint`,
 *  `.hex`, `.spread` (responsive-synth-panels.md). Shared by every faceplate
 *  panel, so the row class is composed in one place. */
export function knobRow(children: HTMLElement[], shape?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = shape ? `${styles.panelRow!} ${shape}` : styles.panelRow!;
  for (const c of children) r.appendChild(c);
  return r;
}

/** What a synth panel body holds, by where it sits. */
export interface PanelZones {
  /** The wave / model selector — flush with the top of the body. */
  top?: HTMLElement;
  /** Centred in all the height between `top` and `bottom`. */
  knobs: HTMLElement[];
  /** The mode control (sync, glide mode, LFO destination) — flush with the bottom. */
  bottom?: HTMLElement;
}

/**
 * Fills a panel body as three zones, so every panel's selectors land on the same
 * lines as its neighbours' whatever each one holds — the headers are one height
 * and the grid stretches a row's panels to one height, so the bodies' edges are
 * shared (responsive-synth-panels.md REQ-selectors-pin-to-the-panel-edges).
 */
export function panelZones(body: HTMLElement, z: PanelZones): void {
  // `.panelEdge` keeps a switch inside the body where the body is narrow
  // (REQ-selectors-never-outgrow-their-panel).
  z.top?.classList.add(styles.panelEdge!);
  z.bottom?.classList.add(styles.panelEdge!);
  if (z.top) body.appendChild(z.top);
  const knobs = document.createElement('div');
  knobs.className = styles.panelKnobs!;
  for (const k of z.knobs) knobs.appendChild(k);
  body.appendChild(knobs);
  if (z.bottom) body.appendChild(z.bottom);
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
 * another panel" on a grid with no columns left (panel-tabs.md, lfo.md REQ-the-two-lfos-share-one-panel).
 *
 * The strip **replaces** the title rather than sitting beside it: each tab
 * names its own page, so a separate heading would only repeat them, and the row
 * keeps a plain panel's header height so a tabbed panel still lines up with its
 * untabbed neighbours (panel-tabs.md REQ-the-strip-replaces-the-title).
 *
 * `data-help` therefore lands on the tab row — still not on a tab button, so the
 * ⓘ badge neither moves nor disappears when the page changes (REQ-data-help-sits-on-the-tab-row).
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
