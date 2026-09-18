import { iconTextEl, type IconName } from './ui-icons';
import styles from '../styles/section-title.module.css';

/**
 * The heading on a full-width faceplate section — `specs/features/section-title.md`.
 *
 * FX, MACHINES and EQUALIZER each had their own idea of a title, and the three
 * disagreed on colour, face and left edge. This is the one place any of that is
 * decided, so they cannot drift apart again (REQ-one-component-draws-every-heading).
 */
export interface SectionTitleOptions {
  /** Title-case in source; the stylesheet uppercases it. */
  text: string;
  icon: IconName;
  /** Visually hide the text at <=1140px, keeping the icon (REQ-compact-drops-text-not-icon). For a bar
   *  whose tabs already fill the row. */
  compact?: boolean;
}

export function createSectionTitle(opts: SectionTitleOptions): HTMLElement {
  // `iconTextEl` rather than `iconLabel`: the text stays a text node, and the
  // icon + `.icon-label` pair gets base.css's gap for free.
  const el = iconTextEl(opts.icon, opts.text);
  el.className = opts.compact ? `${styles.root!} ${styles.compact!}` : styles.root!;
  return el;
}
