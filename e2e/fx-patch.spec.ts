import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * FX patch decoration — scenery that fills the leftover cell an ODD effect count
 * leaves in the ≤992px 2-column grid. See specs/features/fx-patch-decoration.md.
 *
 * It is currently **dormant**: sidechain-ducking added a sixth effect panel, so
 * the row divides evenly at both widths and `buildFx`'s parity guard appends
 * nothing (fx-patch-decoration.md REQ-2 — anticipated, not a regression). What
 * is pinned here is therefore the parity guard itself. A seventh effect brings
 * the scenery back with no code change, and the rendering assertions this file
 * used to make live on in tests/ui/fx-patch-decoration.test.ts, which builds the
 * component directly and still covers REQ-3..REQ-10.
 */
const NARROW = { width: 900, height: 800 }; // 2-column .fxRow
const WIDE = { width: 1400, height: 900 };  // 6-column .fxRow

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
  test('is not built while the effect count is even (REQ-2)', async ({ page }) => {
    await bootWithFxOpen(page, NARROW);

    // Six panels divide evenly into the 2-column grid, so there is no gap to
    // fill and the parity guard appends nothing at all.
    await expect(page.getByTestId('fx-patch-decoration')).toHaveCount(0);

    const columns = await page
      .getByTestId('fx')
      .locator('[data-help="fx.reverb"]')
      .locator('xpath=../../..')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(2);
  });

  test('leaves the six-column row full at desktop width', async ({ page }) => {
    await bootWithFxOpen(page, WIDE);

    await expect(page.getByTestId('fx-patch-decoration')).toHaveCount(0);

    // The row really is six across, i.e. Duck took the cell the scenery used to
    // occupy in the narrow layout.
    const columns = await page
      .getByTestId('fx')
      .locator('[data-help="fx.duck"]')
      .locator('xpath=../../..')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(6);
  });
});
