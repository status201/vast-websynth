// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMenuFor, type ClearRow } from '../../src/ui/panels/step-panel-scaffold';
import { PatternStore } from '../../src/state/patterns';
import { PatternUndo } from '../../src/state/pattern-undo';
import type { StudioApi } from '../../src/ui/studio-api';

/**
 * step-grid-editing.md REQ-6 (v6) — an item that would do nothing is a dead item,
 * on every machine. Through v5 only the Motion panel honoured that, and it did so
 * by choosing what to `push`, so the rule lived in one panel and the other three
 * silently broke it. It now lives in `clearMenuFor`: panels hand over every row
 * they have and declare `hasContent` per row.
 *
 * These pin the central filter — the mechanism that makes the rule universal. The
 * per-machine predicates themselves are driven through the real panels in
 * `e2e/patterns.spec.ts` (seq + drum), `e2e/motion.spec.ts` and
 * `tests/ui/clear-menu-sampler.test.ts`.
 */

function harness(rows: () => ClearRow[]) {
  const patterns = new PatternStore();
  const arrangement = {
    seqPlayBank: 0, drumPlayBank: 0, samplerPlayBank: 0, motionPlayBank: 0,
    seqResting: false, drumResting: false, samplerResting: false, motionResting: false,
    onChange: () => () => {},
  };
  const api = { patterns, arrangement } as unknown as StudioApi;
  document.body.appendChild(clearMenuFor(api, 'seq', new PatternUndo(patterns), rows));

  const byId = (testId: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    open: () => byId('clear-seq')!.click(),
    /** The row items currently in the menu, in order. */
    items: () => [...document.querySelectorAll('[data-testid^="clear-seq-row-"]')]
      .map((el) => el.textContent),
    byId,
  };
}

/** A row that reports itself empty, so the menu must drop it. */
const empty = (label: string): ClearRow => ({ label, hasContent: false, clear: () => false });
const filled = (label: string): ClearRow => ({ label, hasContent: true, clear: () => true });

beforeEach(() => { document.body.innerHTML = ''; });

describe('Clear ▾ drops rows with nothing to clear (step-grid-editing.md REQ-6)', () => {
  it('offers a filled row', () => {
    const h = harness(() => [filled('track 2')]);
    h.open();
    expect(h.items()).toEqual(['Clear track 2']);
  });

  it('leaves Clear bank on its own when the only row is empty', () => {
    const h = harness(() => [empty('track 2')]);
    h.open();
    expect(h.items()).toEqual([]);
    // The bank item is deliberately never filtered — dropping it too would leave
    // an empty menu behind the toggle.
    expect(h.byId('clear-seq-bank')).not.toBeNull();
  });

  it('numbers the surviving rows contiguously, so testids never gap', () => {
    const h = harness(() => [filled('XY'), empty('A'), filled('B')]);
    h.open();
    expect(h.byId('clear-seq-row-0')?.textContent).toBe('Clear XY');
    expect(h.byId('clear-seq-row-1')?.textContent).toBe('Clear B');
    expect(h.byId('clear-seq-row-2')).toBeNull();
  });

  it('re-asks on every open, so a row that fills up comes back', () => {
    let full = false;
    const h = harness(() => [{ label: 'track 2', hasContent: full, clear: () => true }]);

    h.open();
    expect(h.items()).toEqual([]);

    full = true;
    h.open();  // close
    h.open();  // reopen — rows() runs again
    expect(h.items()).toEqual(['Clear track 2']);
  });
});
