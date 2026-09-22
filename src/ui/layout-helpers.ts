import styles from './styles/layout.module.css';

/**
 * The two layout helpers the faceplate's builders share.
 *
 * They lived in `app.ts` as module-private functions, which is where they
 * belonged while every caller did. Splitting the panel builders out left them
 * needed in three files, and exporting them *from* `app.ts` would have pointed
 * the panels back at the shell that composes them — so they moved here instead,
 * which is also where a fourth caller should reach for them.
 */

/** A panel row: the shared class plus an optional modifier. */
export function row(children: HTMLElement[], extraClass?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = extraClass ? `${styles.panelRow!} ${extraClass}` : styles.panelRow!;
  for (const c of children) r.appendChild(c);
  return r;
}

/**
 * The narrow-viewport breakpoint. Read at call time rather than captured: the
 * sections that consult it do so when they are built and when they are
 * collapsed, and a captured boolean would be stale after a resize.
 */
export const isCompact = (): boolean => window.matchMedia('(max-width: 1280px)').matches;
