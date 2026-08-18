import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachChipReorder } from '../../src/ui/components/chip-reorder';

/**
 * The drag rows of the chain-chip gesture inventory
 * (specs/features/arrangement.md REQ-11), one describe per row.
 *
 * jsdom has no layout: `document.elementFromPoint` returns null, so the
 * controller's `e.target` fallback is what resolves the chip under the pointer
 * — dispatch moves *on the chip being crossed*. `getBoundingClientRect` is
 * likewise all zeros, so each chip is given a synthetic box: chip i spans
 * x = i*30 .. i*30+28, which makes its midpoint i*30 + 14.
 */

const CHIP_W = 28;
const CHIP_PITCH = 30;
const midOf = (i: number): number => i * CHIP_PITCH + CHIP_W / 2;
/** Comfortably inside chip i, on the requested side of its midpoint. */
const leftOf = (i: number): number => midOf(i) - 6;
const rightOf = (i: number): number => midOf(i) + 6;

interface Row {
  container: HTMLElement;
  chips: HTMLElement[];
  reorders: ReturnType<typeof vi.fn>;
  clicks: ReturnType<typeof vi.fn>;
  dispose: () => void;
}

function mount(n = 4): Row {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const clicks = vi.fn();
  const chips = Array.from({ length: n }, (_, i) => {
    const el = document.createElement('button');
    el.textContent = String.fromCharCode(65 + i); // A B C D
    el.getBoundingClientRect = () => ({
      x: i * CHIP_PITCH, y: 0, left: i * CHIP_PITCH, right: i * CHIP_PITCH + CHIP_W,
      top: 0, bottom: CHIP_W, width: CHIP_W, height: CHIP_W, toJSON: () => ({}),
    }) as DOMRect;
    // The selection listener the chips really carry — the drag must not fire it.
    el.addEventListener('click', () => clicks(i));
    container.appendChild(el);
    return el;
  });
  const reorders = vi.fn();
  const dispose = attachChipReorder({ container, chips, onReorder: reorders });
  return { container, chips, reorders, clicks, dispose };
}

const down = (el: HTMLElement, x: number, y = 0): void => {
  el.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, button: 0 }));
};
const move = (el: HTMLElement, x: number, y = 0): void => {
  el.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
};
const up = (el: HTMLElement, x: number, y = 0): void => {
  el.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, bubbles: true }));
};
const cancel = (el: HTMLElement, x: number, y = 0): void => {
  el.dispatchEvent(new MouseEvent('pointercancel', { clientX: x, clientY: y, bubbles: true }));
};
const click = (el: HTMLElement): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

describe('attachChipReorder', () => {
  let row: Row | null = null;
  let extra: Row | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    row?.dispose();
    extra?.dispose();
    row = null;
    extra = null;
    vi.useRealTimers();
  });

  describe('drag past the slop reorders (REQ-11)', () => {
    it('moves the dragged slot to the gap it was dropped in', () => {
      row = mount();
      // A B C D — carry D to the left half of B.
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      up(row.chips[1]!, leftOf(1));
      // Gap 1 in original coordinates; D removed from 3 lands at 1 -> A D B C.
      expect(row.reorders).toHaveBeenCalledExactlyOnceWith(3, 1);
    });

    it('drops after the chip when released past its midpoint', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, rightOf(1));
      up(row.chips[1]!, rightOf(1));
      // Gap 2 -> after removing index 3 the slot lands at 2 -> A B D C.
      expect(row.reorders).toHaveBeenCalledExactlyOnceWith(3, 2);
    });

    it('drops past the last chip to append rather than swapping with it', () => {
      row = mount();
      down(row.chips[0]!, midOf(0));
      move(row.chips[3]!, rightOf(3));
      up(row.chips[3]!, rightOf(3));
      // Gap 4 (the end) -> A removed from 0 lands last -> B C D A.
      expect(row.reorders).toHaveBeenCalledExactlyOnceWith(0, 3);
    });

    it('commits exactly once, on drop — never per move', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[2]!, leftOf(2));
      move(row.chips[1]!, leftOf(1));
      move(row.chips[0]!, leftOf(0));
      expect(row.reorders).not.toHaveBeenCalled();
      up(row.chips[0]!, leftOf(0));
      expect(row.reorders).toHaveBeenCalledTimes(1);
    });
  });

  describe('a press under the slop is still a tap (REQ-11)', () => {
    it('does not reorder', () => {
      row = mount();
      down(row.chips[1]!, midOf(1));
      move(row.chips[1]!, midOf(1) + 3); // 3px — inside the 6px slop
      up(row.chips[1]!, midOf(1) + 3);
      expect(row.reorders).not.toHaveBeenCalled();
    });

    it('leaves the chip’s own click listener free to select', () => {
      row = mount();
      down(row.chips[1]!, midOf(1));
      move(row.chips[1]!, midOf(1) + 3);
      up(row.chips[1]!, midOf(1) + 3);
      click(row.chips[1]!);
      expect(row.clicks).toHaveBeenCalledExactlyOnceWith(1);
    });
  });

  describe('a drag never doubles as a selection click (REQ-11)', () => {
    it('swallows the click the drop produces', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      up(row.chips[1]!, leftOf(1));
      click(row.chips[1]!);
      expect(row.clicks).not.toHaveBeenCalled();
    });

    it('does not stay armed for the user’s next genuine tap', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      up(row.chips[1]!, leftOf(1));
      // A touch drag produces no click at all; the sweep must disarm it anyway.
      vi.advanceTimersByTime(1);
      click(row.chips[1]!);
      expect(row.clicks).toHaveBeenCalledExactlyOnceWith(1);
    });
  });

  describe('a cancelled or stray drop writes nothing (REQ-11)', () => {
    it('writes nothing on pointercancel', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      cancel(row.chips[1]!, leftOf(1));
      expect(row.reorders).not.toHaveBeenCalled();
    });

    it('writes nothing when released away from every chip', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      move(row.container, 500);   // off the chips, still inside the panel
      up(row.container, 500);
      expect(row.reorders).not.toHaveBeenCalled();
    });

    it('writes nothing when a chip is picked up and put back', () => {
      row = mount();
      down(row.chips[1]!, midOf(1));
      move(row.chips[1]!, leftOf(1) - 8); // travels, but the gap resolves to 1
      up(row.chips[1]!, leftOf(1) - 8);
      expect(row.reorders).not.toHaveBeenCalled();
    });
  });

  describe('a drag never crosses into another lane (REQ-11)', () => {
    it('ignores chips belonging to a different controller', () => {
      row = mount();
      extra = mount();
      down(row.chips[3]!, midOf(3));
      move(extra.chips[1]!, leftOf(1));
      up(extra.chips[1]!, leftOf(1));
      expect(row.reorders).not.toHaveBeenCalled();
      expect(extra.reorders).not.toHaveBeenCalled();
    });
  });

  describe('the drag affordance', () => {
    it('marks the carried chip and the gap, then clears both on drop', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      expect(row.chips[3]!.dataset.dragging).toBe('true');
      expect(row.chips[1]!.dataset.dragOver).toBe('before');
      // The gap to the RIGHT of chip 1 is the same gap as "before chip 2", so
      // that is where the bar goes. 'after' is reserved for the one gap with no
      // chip in front of it: the end of the chain.
      move(row.chips[1]!, rightOf(1));
      expect(row.chips[1]!.dataset.dragOver).toBeUndefined();
      expect(row.chips[2]!.dataset.dragOver).toBe('before');
      up(row.chips[1]!, rightOf(1));
      expect(row.chips.every((c) => !c.dataset.dragging && !c.dataset.dragOver)).toBe(true);
    });

    it('marks the last chip “after” for a drop at the end of the chain', () => {
      row = mount();
      down(row.chips[0]!, midOf(0));
      move(row.chips[3]!, rightOf(3));
      expect(row.chips[3]!.dataset.dragOver).toBe('after');
    });

    it('marks only one gap at a time', () => {
      row = mount();
      down(row.chips[0]!, midOf(0));
      move(row.chips[2]!, leftOf(2));
      move(row.chips[3]!, leftOf(3));
      expect(row.chips.filter((c) => c.dataset.dragOver !== undefined)).toHaveLength(1);
    });

    it('withdraws the marker when the pointer leaves the row', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      move(row.container, 500);
      expect(row.chips.some((c) => c.dataset.dragOver !== undefined)).toBe(false);
    });

    it('shows nothing until the press has travelled', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[3]!, midOf(3) + 3);
      expect(row.chips[3]!.dataset.dragging).toBeUndefined();
    });
  });

  describe('lifetime', () => {
    it('stops listening once disposed, so a rebuilt row cannot double-fire', () => {
      row = mount();
      row.dispose();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      up(row.chips[1]!, leftOf(1));
      expect(row.reorders).not.toHaveBeenCalled();
    });

    it('leaves the chips as it found them', () => {
      row = mount();
      row.dispose();
      expect(row.chips.every((c) => !c.hasAttribute('data-chip-reorder'))).toBe(true);
      expect(row.chips.every((c) => c.style.touchAction === '')).toBe(true);
    });

    it('drops a half-finished drag when disposed mid-gesture', () => {
      row = mount();
      down(row.chips[3]!, midOf(3));
      move(row.chips[1]!, leftOf(1));
      row.dispose();
      up(row.chips[1]!, leftOf(1));
      expect(row.reorders).not.toHaveBeenCalled();
      expect(row.chips[3]!.dataset.dragging).toBeUndefined();
    });
  });
});
