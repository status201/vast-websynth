import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * Responsive header — below 720px the preset cluster (Preset/Save/Perf/About/
 * Help) collapses behind a hamburger (☰) to keep the sticky header compact, and
 * expands inline only on tap. Wider screens keep it inline with no hamburger.
 * See specs/features/responsive-header.md.
 */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

test.describe('responsive header (mobile menu)', () => {
  test('collapses the preset cluster behind a hamburger on a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await gotoAndStart(page);

    const menu = page.getByTestId('header-menu');
    const preset = page.getByTestId('preset-select');

    // Collapsed by default: toggle shown, preset cluster hidden, transport stays.
    await expect(menu).toBeVisible();
    await expect(preset).toBeHidden();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');

    // Tap ☰ → cluster expands inline.
    await menu.click();
    await expect(preset).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');

    // Tap again → collapses.
    await menu.click();
    await expect(preset).toBeHidden();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
  });

  test('shows the preset cluster inline with no hamburger on a wide screen', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoAndStart(page);

    await expect(page.getByTestId('header-menu')).toBeHidden();
    await expect(page.getByTestId('preset-select')).toBeVisible();
  });
});
