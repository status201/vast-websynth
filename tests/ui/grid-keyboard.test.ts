// @vitest-environment jsdom
// step-grid-editing.md REQ-a-trigger-grid-is-reachable-by-keyboard — the drum and
// sampler grids through the shared GridCursor.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GridCursor } from '../../src/ui/panels/step-panel-scaffold';
import { StepButton } from '../../src/ui/components/step-button';

const ROWS = 3;
const COLS = 16;

function rig(cols = 16) {
  const on = Array.from({ length: ROWS }, () => new Array<boolean>(COLS).fill(false));
  const cells = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => new StepButton('')));
  for (const row of cells) for (const sb of row) document.body.appendChild(sb.el);
  const cursor = new GridCursor(cells, () => {});
  cursor.enableKeyboard({
    isOn: (r, c) => on[r]![c]!,
    onToggle: (r, c, v) => { on[r]![c] = v; },
    cols: () => cols,
    rowLabel: (r) => `Row ${r + 1}`,
  });
  /** Press `key` on whatever has focus; returns whether something above the cell saw it. */
  const press = (key: string, init: KeyboardEventInit = {}): boolean => {
    const reachedWindow = vi.fn();
    window.addEventListener('keydown', reachedWindow, { once: true });
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    window.removeEventListener('keydown', reachedWindow);
    return reachedWindow.mock.calls.length > 0;
  };
  const tabStops = () => cells.flat().filter((sb) => sb.el.tabIndex === 0);
  return { on, cells, cursor, press, tabStops };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('trigger grid keyboard', () => {
  it('has exactly one Tab stop, and it follows the selection', () => {
    const r = rig();
    expect(r.tabStops()).toEqual([r.cells[0]![0]]);
    r.cursor.set(2, 5);   // a pointer selection
    expect(r.tabStops()).toEqual([r.cells[2]![5]]);
  });

  it('arrows move selection and focus; Enter toggles', () => {
    const r = rig();
    r.cells[0]![0]!.el.focus();
    r.press('ArrowRight');
    r.press('ArrowRight');
    r.press('ArrowRight');
    r.press('ArrowDown');
    expect([r.cursor.selRow, r.cursor.selCol]).toEqual([1, 3]);
    expect(document.activeElement).toBe(r.cells[1]![3]!.el);
    r.press('Enter');
    expect(r.on[1]![3]).toBe(true);
    expect(r.cells[1]![3]!.el.getAttribute('aria-label')).toBe('Row 2, step 4, on');
    r.press('Enter');
    expect(r.on[1]![3]).toBe(false);
  });

  it('stays inside the played window', () => {
    const r = rig(12);   // 3/4: 12 played cells
    r.cells[0]![0]!.el.focus();
    r.press('End');
    expect(r.cursor.selCol).toBe(11);
    r.press('ArrowRight');
    expect(r.cursor.selCol).toBe(11);
    r.press('Home');
    expect(r.cursor.selCol).toBe(0);
    r.press('ArrowLeft');
    r.press('ArrowUp');
    expect([r.cursor.selRow, r.cursor.selCol]).toEqual([0, 0]);
  });

  it('consumes only its own keys: Space, Delete, Shift+arrows and letters pass on', () => {
    const r = rig();
    r.cells[0]![0]!.el.focus();
    expect(r.press('ArrowRight')).toBe(false);
    expect(r.press('Enter')).toBe(false);
    const before = r.on.map((row) => [...row]);
    expect(r.press(' ')).toBe(true);
    expect(r.on).toEqual(before);                 // Space toggled nothing
    expect(r.press('Delete')).toBe(true);
    expect(r.press('ArrowRight', { shiftKey: true })).toBe(true);
    expect(r.press('z')).toBe(true);
  });
});
