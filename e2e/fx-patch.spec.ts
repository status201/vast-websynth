import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * FX patch decoration — five effect panels in the ≤992px 2-column grid leave one
 * cell empty, filled by the unpatched-cable scenery. The 5-column layout has no
 * gap, so it stays hidden there. See specs/features/fx-patch-decoration.md.
 */
const NARROW = { width: 900, height: 800 }; // 2-column .fxRow
const WIDE = { width: 1400, height: 900 };  // 5-column .fxRow

/** Pin the FX section open: it auto-collapses below 1280px (app.ts isCompact). */
async function bootWithFxOpen(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.ui.collapsed.fx', '0');
    } catch {
      /* ignore */
    }
  });
  await gotoAndStart(page);
  await expect(page.getByTestId('fx')).toBeVisible();
}

test.describe('FX patch decoration', () => {
  test('fills the empty cell next to Reverb on a 2-column FX row', async ({ page }) => {
    await bootWithFxOpen(page, NARROW);

    const deco = page.getByTestId('fx-patch-decoration');
    await expect(deco).toBeVisible();

    // It really is the leftover cell of a 2-column grid (REQ-1).
    const columns = await deco.evaluate(
      (el) => getComputedStyle(el.parentElement!).gridTemplateColumns.split(' ').length,
    );
    expect(columns).toBe(2);

    // Same row as Reverb, to its right. Compared against the Reverb *panel*
    // (the title's grandparent), not its title: the slot is inset from its cell
    // (REQ-8), so its top now sits below the title's.
    const reverb = page.getByTestId('fx').locator('[data-help="fx.reverb"]').locator('xpath=../..');
    const rBox = (await reverb.boundingBox())!;
    const dBox = (await deco.boundingBox())!;
    expect(dBox.x).toBeGreaterThan(rBox.x + rBox.width);
    // Vertical overlap — the two share the row.
    expect(dBox.y).toBeLessThan(rBox.y + rBox.height);
    expect(dBox.y + dBox.height).toBeGreaterThan(rBox.y);

    // Inset on every side (REQ-8): the reveal around it is what reads as room
    // for a module's front plate, and it is drawn with no border of its own.
    const box = await deco.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        top: parseFloat(s.marginTop),
        right: parseFloat(s.marginRight),
        border: parseFloat(s.borderTopWidth),
      };
    });
    expect(box.top).toBeGreaterThan(0);
    expect(box.right).toBeGreaterThan(0);
    expect(box.border).toBe(0);

    // Decorative only (REQ-3): both layers present, nothing focusable.
    await expect(deco.locator('svg')).toHaveCount(2);
    await expect(deco.locator('button, a, input, [tabindex]')).toHaveCount(0);
  });

  test('stays hidden where the 5-column FX row is full', async ({ page }) => {
    await bootWithFxOpen(page, WIDE);

    // Present in the DOM (parity-keyed at build time) but not rendered.
    const deco = page.getByTestId('fx-patch-decoration');
    await expect(deco).toHaveCount(1);
    await expect(deco).toBeHidden();

    const columns = await deco.evaluate(
      (el) => getComputedStyle(el.parentElement!).gridTemplateColumns.split(' ').length,
    );
    expect(columns).toBe(5);
  });
});
