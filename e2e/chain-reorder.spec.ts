import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Drag a chain chip to reorder a lane — arrangement.md REQ-11 and the drag row
 * of the chip's gesture inventory.
 *
 * Why it exists: every add button appends, so a bank that belongs near the
 * front of the chain used to cost one `◀` press per position it had to travel.
 *
 * The unit suite (tests/ui/chip-reorder.test.ts) pins the controller's arithmetic
 * against synthetic boxes; what only a browser can answer is whether the gesture
 * survives real layout, real hit-testing and the panel's own re-render — so
 * these drive `page.mouse` over the actual chips.
 */
test.describe('chain reorder by drag', () => {
  const seqSteps = (page: any) =>
    page.evaluate(() => (window as any).__synth.engine.arrangement.seq.steps as number[]);
  const seqTranspose = (page: any) =>
    page.evaluate(() => (window as any).__synth.engine.arrangement.seq.transpose as number[]);

  /** Drag `from` onto the given side of `to`, in real pixels. */
  const dragChip = async (page: any, from: string, to: string, side: 'left' | 'right') => {
    const a = (await page.getByTestId(from).boundingBox())!;
    const b = (await page.getByTestId(to).boundingBox())!;
    const targetX = side === 'left' ? b.x + b.width * 0.25 : b.x + b.width * 0.75;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    // Two moves: the first crosses the slop and arms the drag, the second
    // settles on the gap. One jump can be coalesced into a single event.
    await page.mouse.move(targetX, b.y + b.height / 2, { steps: 8 });
    await page.mouse.move(targetX, b.y + b.height / 2);
    await page.mouse.up();
  };

  test('a chip dropped before another lands there, and the drop is not a click', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // Build A B C D.
    await page.getByTestId('chain-add-seq-1').click();
    await page.getByTestId('chain-add-seq-2').click();
    await page.getByTestId('chain-add-seq-3').click();
    await expect(page.getByTestId('chain-chip-seq-3')).toHaveText('D');
    expect(await seqSteps(page)).toEqual([0, 1, 2, 3]);

    // Carry D to the front half of B -> A D B C.
    await dragChip(page, 'chain-chip-seq-3', 'chain-chip-seq-1', 'left');
    expect(await seqSteps(page)).toEqual([0, 3, 1, 2]);
    await expect(page.getByTestId('chain-chip-seq-1')).toHaveText('D');

    // The drop moved the selection with the slot rather than toggling it: the
    // `✕` that follows must remove the chip that was just dropped.
    await page.getByTestId('chain-remove-seq').click();
    expect(await seqSteps(page)).toEqual([0, 1, 2]);
  });

  test('a dragged slot carries its transpose with it', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // A A A, with the last slot at +7.
    await page.getByTestId('chain-add-seq-0').click();
    await page.getByTestId('chain-add-seq-0').click();
    await page.getByTestId('chain-chip-seq-2').click();
    const up = page.getByTestId('chain-transpose-up-seq');
    for (let i = 0; i < 7; i++) await up.click();
    expect(await seqTranspose(page)).toEqual([0, 0, 7]);
    await expect(page.getByTestId('chain-chip-seq-2')).toHaveText('A+7');

    // Drag it to the front: the offset belongs to the slot, not the position,
    // so the progression is reordered rather than rewritten.
    await dragChip(page, 'chain-chip-seq-2', 'chain-chip-seq-0', 'left');
    expect(await seqTranspose(page)).toEqual([7, 0, 0]);
    await expect(page.getByTestId('chain-chip-seq-0')).toHaveText('A+7');
  });

  test('a plain click still selects — the drag did not take the tap away', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('chain-add-seq-1').click();
    expect(await seqSteps(page)).toEqual([0, 1]);

    // Select slot 1 with an ordinary click, then act on the selection.
    await page.getByTestId('chain-chip-seq-1').click();
    await page.getByTestId('chain-remove-seq').click();
    expect(await seqSteps(page)).toEqual([0]);
  });

  test('a transposed chip can show that it is selected as well (REQ-12)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('chain-add-seq-0').click();
    await page.getByTestId('chain-chip-seq-1').click();
    await page.getByTestId('chain-transpose-up-seq').click();

    // Both facts on one chip at once — the collision REQ-12 removed was that
    // the transposed styling made the selection invisible.
    const chip = page.getByTestId('chain-chip-seq-1');
    await expect(chip).toHaveAttribute('data-transposed', 'true');
    await expect(chip).toHaveClass(/\bsel\b/);
    // Distinct colours, not one borrowed from the other.
    const seen = await chip.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, border: cs.borderTopColor };
    });
    expect(seen.color).not.toBe(seen.border);
  });

  test('a drag cannot move a bank from one machine to another', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('chain-add-seq-1').click();
    await page.getByTestId('chain-add-drum-2').click();
    const seqBefore = await seqSteps(page);
    const drumBefore = await page.evaluate(
      () => (window as any).__synth.engine.arrangement.drum.steps as number[]);

    await dragChip(page, 'chain-chip-seq-1', 'chain-chip-drum-0', 'left');

    expect(await seqSteps(page)).toEqual(seqBefore);
    expect(await page.evaluate(
      () => (window as any).__synth.engine.arrangement.drum.steps as number[])).toEqual(drumBefore);
  });
});
