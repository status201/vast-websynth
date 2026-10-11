import styles from '../styles/chooser.module.css';

/**
 * The described choices inside a dialog (specs/features/chooser-rows.md): the
 * Export chooser, the Preset manager's doors and the Export audio dialog's
 * option rows all build from here, so their look is one stylesheet. DOM only —
 * the caller adds the listener, toggles `.on` and sets `disabled`.
 */

/** The column that holds a dialog's chooser rows. */
export function chooserRows(): HTMLDivElement {
  const rows = document.createElement('div');
  rows.className = styles.rows!;
  return rows;
}

/** One described choice: a title over a one-line description (REQ-one-chooser-row-builder). */
export function chooserRow(title: string, desc: string, testId: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = styles.row!;
  b.dataset.testid = testId;
  const t = document.createElement('span');
  t.className = styles.rowTitle!;
  t.textContent = title;
  const d = document.createElement('span');
  d.className = styles.rowDesc!;
  d.textContent = desc;
  b.append(t, d);
  return b;
}

/** "LABEL: [control]" (REQ-option-rows-pair-a-label-with-a-control). */
export function optionRow(label: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement('div');
  row.className = styles.optionRow!;
  const l = document.createElement('span');
  l.className = styles.optionLabel!;
  l.textContent = label;
  row.append(l, control);
  return row;
}

/** A dialog's small italic aside. */
export function chooserNote(text = ''): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = styles.note!;
  p.textContent = text;
  return p;
}
