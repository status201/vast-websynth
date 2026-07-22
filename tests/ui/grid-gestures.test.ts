import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachGridGestures } from '../../src/ui/components/grid-gestures';

/**
 * The gesture inventory of specs/features/step-grid-editing.md, one describe
 * per row. jsdom has no layout, so `document.elementFromPoint` always returns
 * null and the controller's `e.target` fallback is what resolves painted cells
 * — dispatch moves *on the cell being crossed*.
 */

const HOLD_MS = 350;

interface Grid {
  cells: HTMLElement[][];
  on: boolean[][];
  toggles: ReturnType<typeof vi.fn>;
  selects: ReturnType<typeof vi.fn>;
  dispose: () => void;
}

function mount(rows = 1, cols = 4): Grid {
  const on = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  const cells = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const el = document.createElement('button');
      el.dataset.rc = `${r}:${c}`;
      document.body.appendChild(el);
      return el;
    }),
  );
  const toggles = vi.fn((r: number, c: number, v: boolean) => { on[r]![c] = v; });
  const selects = vi.fn();
  const dispose = attachGridGestures({
    cells,
    isOn: (r, c) => on[r]![c]!,
    onToggle: toggles,
    onSelect: selects,
    heldClass: 'held',
    holdMs: HOLD_MS,
  });
  return { cells, on, toggles, selects, dispose };
}

const down = (el: HTMLElement, x = 0, y = 0): void => {
  el.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, button: 0 }));
};
const move = (el: HTMLElement, x: number, y = 0): void => {
  el.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
};
const up = (el: HTMLElement, x = 0, y = 0): void => {
  el.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, bubbles: true }));
};

describe('attachGridGestures', () => {
  let grid: Grid | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    grid?.dispose();
    grid = null;
    vi.useRealTimers();
  });

  describe('tap (REQ-1)', () => {
    it('toggles the cell on and selects it', () => {
      grid = mount();
      const cell = grid.cells[0]![0]!;
      down(cell);
      up(cell);
      expect(grid.selects).toHaveBeenCalledWith(0, 0);
      expect(grid.toggles).toHaveBeenCalledWith(0, 0, true);
    });

    it('toggles a lit cell back off', () => {
      grid = mount();
      grid.on[0]![0] = true;
      const cell = grid.cells[0]![0]!;
      down(cell);
      up(cell);
      expect(grid.toggles).toHaveBeenCalledWith(0, 0, false);
    });

    it('selects before it toggles, so the edit row already points at the cell', () => {
      grid = mount();
      const order: string[] = [];
      grid.dispose();
      const dispose = attachGridGestures({
        cells: grid.cells,
        isOn: () => false,
        onToggle: () => order.push('toggle'),
        onSelect: () => order.push('select'),
      });
      const cell = grid.cells[0]![1]!;
      down(cell);
      up(cell);
      expect(order).toEqual(['select', 'toggle']);
      dispose();
    });
  });

  describe('long-press (REQ-3)', () => {
    it('selects without toggling — the freak-out regression', () => {
      grid = mount();
      grid.on[0]![2] = true;
      const cell = grid.cells[0]![2]!;
      down(cell);
      vi.advanceTimersByTime(HOLD_MS + 10);
      up(cell);
      expect(grid.selects).toHaveBeenCalledWith(0, 2);
      expect(grid.toggles).not.toHaveBeenCalled();
      expect(grid.on[0]![2]).toBe(true); // still lit, ready to edit
    });

    it('marks the held cell while the press is down and clears it on release', () => {
      grid = mount();
      const cell = grid.cells[0]![0]!;
      down(cell);
      vi.advanceTimersByTime(HOLD_MS + 10);
      expect(cell.classList.contains('held')).toBe(true);
      up(cell);
      expect(cell.classList.contains('held')).toBe(false);
    });

    it('is cancelled by movement, so a drag never fires it (edge)', () => {
      grid = mount();
      const cell = grid.cells[0]![0]!;
      down(cell, 0, 0);
      move(cell, 40, 0);                       // travel past the slop
      vi.advanceTimersByTime(HOLD_MS + 10);    // the hold timer must be dead
      expect(cell.classList.contains('held')).toBe(false);
      up(grid.cells[0]![1]!);
      expect(grid.toggles).toHaveBeenCalledTimes(1); // the paint, not a stray tap
    });

    it('right-click selects without toggling and suppresses the browser menu', () => {
      grid = mount();
      grid.on[0]![1] = true;
      const cell = grid.cells[0]![1]!;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      cell.dispatchEvent(ev);
      expect(grid.selects).toHaveBeenCalledWith(0, 1);
      expect(grid.toggles).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(true);
    });
  });

  describe('paint-drag (REQ-4)', () => {
    it('fills a run when the stroke starts on a dead cell', () => {
      grid = mount(1, 4);
      down(grid.cells[0]![0]!, 0, 0);
      move(grid.cells[0]![0]!, 10, 0);   // past the slop → paints the origin
      move(grid.cells[0]![1]!, 20, 0);
      move(grid.cells[0]![2]!, 30, 0);
      up(grid.cells[0]![2]!, 30, 0);
      expect(grid.on[0]).toEqual([true, true, true, false]);
    });

    it('erases a run when the stroke starts on a lit cell', () => {
      grid = mount(1, 4);
      grid.on[0] = [true, true, true, false];
      down(grid.cells[0]![0]!, 0, 0);
      move(grid.cells[0]![0]!, 10, 0);
      move(grid.cells[0]![1]!, 20, 0);
      move(grid.cells[0]![2]!, 30, 0);
      up(grid.cells[0]![2]!, 30, 0);
      expect(grid.on[0]).toEqual([false, false, false, false]);
    });

    it('applies the latched value, not a per-cell invert (edge)', () => {
      grid = mount(1, 4);
      grid.on[0] = [true, false, true, false];  // mixed run
      down(grid.cells[0]![0]!, 0, 0);           // starts lit → latch = erase
      move(grid.cells[0]![0]!, 10, 0);
      move(grid.cells[0]![1]!, 20, 0);          // already off — must stay off
      move(grid.cells[0]![2]!, 30, 0);
      up(grid.cells[0]![2]!, 30, 0);
      expect(grid.on[0]).toEqual([false, false, false, false]);
      expect(grid.toggles).toHaveBeenCalledTimes(2); // cell 1 was already at the latch
    });

    it('does not re-write a cell the stroke crosses twice (no flicker)', () => {
      grid = mount(1, 3);
      down(grid.cells[0]![0]!, 0, 0);
      move(grid.cells[0]![0]!, 10, 0);
      move(grid.cells[0]![1]!, 20, 0);
      move(grid.cells[0]![0]!, 10, 0);   // back over the origin
      up(grid.cells[0]![0]!, 10, 0);
      expect(grid.toggles).toHaveBeenCalledTimes(2);
      expect(grid.on[0]).toEqual([true, true, false]);
    });

    it('paints across rows on a 2-D grid', () => {
      grid = mount(2, 3);
      down(grid.cells[0]![0]!, 0, 0);
      move(grid.cells[0]![0]!, 10, 0);
      move(grid.cells[1]![1]!, 20, 20);   // diagonal
      up(grid.cells[1]![1]!, 20, 20);
      expect(grid.on[0]![0]).toBe(true);
      expect(grid.on[1]![1]).toBe(true);
    });

    it('does not emit a trailing tap toggle when the stroke ends', () => {
      grid = mount(1, 3);
      down(grid.cells[0]![0]!, 0, 0);
      move(grid.cells[0]![0]!, 10, 0);
      move(grid.cells[0]![1]!, 20, 0);
      up(grid.cells[0]![1]!, 20, 0);
      expect(grid.toggles).toHaveBeenCalledTimes(2); // two cells, not three
    });

    it('a sub-slop wobble is still a tap, not a paint', () => {
      grid = mount(1, 3);
      down(grid.cells[0]![0]!, 0, 0);
      move(grid.cells[0]![0]!, 3, 2);   // inside the 6px slop
      up(grid.cells[0]![0]!, 3, 2);
      expect(grid.toggles).toHaveBeenCalledTimes(1);
      expect(grid.toggles).toHaveBeenCalledWith(0, 0, true);
    });
  });

  describe('lifecycle', () => {
    it('the disposer removes every listener', () => {
      grid = mount();
      grid.dispose();
      const cell = grid.cells[0]![0]!;
      down(cell);
      up(cell);
      expect(grid.toggles).not.toHaveBeenCalled();
      expect(grid.selects).not.toHaveBeenCalled();
      grid = null;
    });

    it('ignores the secondary mouse button (contextmenu owns it)', () => {
      grid = mount();
      const cell = grid.cells[0]![0]!;
      cell.dispatchEvent(new MouseEvent('pointerdown', { button: 2, bubbles: true }));
      up(cell);
      expect(grid.toggles).not.toHaveBeenCalled();
    });
  });
});
