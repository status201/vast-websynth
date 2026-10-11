import { describe, it, expect } from 'vitest';
import { chooserNote, chooserRow, chooserRows, optionRow } from '../../src/ui/components/chooser';
import styles from '../../src/ui/styles/chooser.module.css';

// specs/features/chooser-rows.md — the one builder the Export, Export audio and
// Preset manager dialogs share, so their rows cannot drift apart again.
describe('chooser rows', () => {
  it('builds every described choice as the same card (REQ-one-chooser-row-builder)', () => {
    const b = chooserRow('Song (.json)', 'Audio not included.', 'export-kind-json');
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.dataset.testid).toBe('export-kind-json');
    expect(b.className).toBe(styles.row);
    const [title, desc] = Array.from(b.children);
    expect(title!.className).toBe(styles.rowTitle);
    expect(title!.textContent).toBe('Song (.json)');
    expect(desc!.className).toBe(styles.rowDesc);
    expect(desc!.textContent).toBe('Audio not included.');
    expect(chooserRows().className).toBe(styles.rows);
  });

  it('pairs a label with the very control it was given (REQ-option-rows-pair-a-label-with-a-control)', () => {
    const control = document.createElement('div');
    const row = optionRow('Clips:', control);
    expect(row.className).toBe(styles.optionRow);
    expect(row.children).toHaveLength(2);
    expect(row.children[0]!.className).toBe(styles.optionLabel);
    expect(row.children[0]!.textContent).toBe('Clips:');
    expect(row.children[1]).toBe(control);
  });

  it('builds the italic aside, empty until a dialog fills it', () => {
    expect(chooserNote().className).toBe(styles.note);
    expect(chooserNote().textContent).toBe('');
    expect(chooserNote('MP3 pads clips.').textContent).toBe('MP3 pads clips.');
  });
});
