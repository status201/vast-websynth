import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * The LIVE FX floating window — surfaces the live DJ controls (DJ Filter, Fill,
 * Stutter, Drop, Tape Stop) + an XY Pad launcher in a non-modal window opened from
 * the Song panel, so they're usable off the Song tab. Both XY Pad launchers share
 * one window. See specs/features/live-fx-window.md.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const fillActive = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).__synth.engine.perf.fillActive as boolean);

test.describe('LIVE FX window', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
  });

  test('the launcher doubles as the section title: leads the row with a window glyph', async ({ page }) => {
    const open = page.getByTestId('livefx-open');
    // The "opens a new window" glyph is drawn, not typed (iconography.md).
    await expect(open.locator('svg.ui-icon')).toHaveCount(1);
    await expect(open).toHaveAttribute('aria-label', 'Open LIVE FX window');

    // Row order: LIVE FX (first) → DJ FLT knob → Fill → … (the button replaced the label).
    const layout = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="livefx-open"]')!.parentElement!;
      const kids = Array.from(row.children) as HTMLElement[];
      const pos = (id: string) => kids.findIndex((k) => k.dataset.testid === id);
      return { first: kids[0]?.dataset.testid, dj: pos('knob-fx.djfilter'), fill: pos('perf-fill') };
    });
    expect(layout.first).toBe('livefx-open');
    expect(layout.dj).toBeGreaterThan(-1);
    expect(layout.dj).toBeLessThan(layout.fill); // DJ FLT is second, before Fill
  });

  test('opens from the Song panel and hosts the DJ controls', async ({ page }) => {
    await page.getByTestId('livefx-open').click();
    const win = page.getByTestId('livefx-window');
    await expect(win).toBeVisible();

    for (const id of ['livefx-fill', 'livefx-stutter', 'livefx-drop', 'livefx-tapestop', 'livefx-xypad']) {
      await expect(win.getByTestId(id)).toBeVisible();
    }
    // The DJ Filter knob is present (scoped to the window — the same param mirrors
    // the Song panel's knob, so the testid is shared).
    await expect(win.getByTestId('knob-fx.djfilter')).toBeVisible();

    // The launcher toggles it shut again.
    await page.getByTestId('livefx-open').click();
    await expect(win).toBeHidden();
  });

  test('a LIVE FX control drives the same Performance state as the Song panel', async ({ page }) => {
    await page.getByTestId('livefx-open').click();
    const fill = page.getByTestId('livefx-window').getByTestId('livefx-fill');

    await fill.dispatchEvent('pointerdown');
    await expect.poll(() => fillActive(page)).toBe(true);
    await fill.dispatchEvent('pointerup');
    await expect.poll(() => fillActive(page)).toBe(false);
  });

  test('the minimise button collapses the body and restores it', async ({ page }) => {
    await page.getByTestId('livefx-open').click();
    const win = page.getByTestId('livefx-window');
    await expect(win.getByTestId('livefx-fill')).toBeVisible();

    await win.getByLabel('Minimise').click();
    await expect(win.getByTestId('livefx-fill')).toBeHidden();
    // The window title bar stays; the button now restores.
    await win.getByLabel('Restore').click();
    await expect(win.getByTestId('livefx-fill')).toBeVisible();
  });

  test('both XY Pad launchers toggle a single shared window', async ({ page }) => {
    // Open the XY Pad from the Song panel's launcher.
    await page.getByTestId('perf-xypad').click();
    await expect(page.getByTestId('xypad-window')).toBeVisible();
    await expect(page.getByTestId('xypad-window')).toHaveCount(1);

    // Open the LIVE FX window and toggle the SAME XY Pad window from its launcher.
    await page.getByTestId('livefx-open').click();
    await page.getByTestId('livefx-window').getByTestId('livefx-xypad').click();
    await expect(page.getByTestId('xypad-window')).toBeHidden();
    // Never a second instance.
    await page.getByTestId('livefx-window').getByTestId('livefx-xypad').click();
    await expect(page.getByTestId('xypad-window')).toHaveCount(1);
  });

  test('stays usable after switching away from the Song tab', async ({ page }) => {
    await page.getByTestId('livefx-open').click();
    const win = page.getByTestId('livefx-window');
    await expect(win).toBeVisible();

    // Switch to another tab — the floating window rides above every tab.
    await page.getByTestId('tab-arp').click();
    await expect(win).toBeVisible();

    const fill = win.getByTestId('livefx-fill');
    await fill.dispatchEvent('pointerdown');
    await expect.poll(() => fillActive(page)).toBe(true);
    await fill.dispatchEvent('pointerup');
  });
});
