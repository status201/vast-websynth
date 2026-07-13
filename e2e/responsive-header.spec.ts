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
// Inside the 993–1140px dead zone (iPad Pro): the header's min-content width
// exceeds the viewport, so without the ≤1140px wrap step it overflows and the
// page's overflow-x:hidden clips the right edge (REQ-7).
const TABLET = { width: 1024, height: 768 };

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

    // The toggle is parked at the far right of the brand row, and the header
    // line break pushes the transport cluster to the row below (REQ-1/REQ-4).
    const menuBox = (await menu.boundingBox())!;
    const headerBox = (await page.getByTestId('app-header').boundingBox())!;
    const playBox = (await page.getByTestId('transport-play').boundingBox())!;
    expect(menuBox.x + menuBox.width).toBeGreaterThan(headerBox.x + headerBox.width - 24);
    expect(playBox.y).toBeGreaterThanOrEqual(menuBox.y + menuBox.height);

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

  test('nothing is clipped off the right edge at 1024px (header wraps)', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await gotoAndStart(page);

    // Neither the page nor the header may overflow horizontally. The header
    // check matters: its flex row can spill content past its own box without
    // widening the document, so page scrollWidth alone misses the clipping.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const header = document.querySelector('[data-testid="app-header"]')!;
      return {
        page: doc.scrollWidth - doc.clientWidth,
        header: header.scrollWidth - header.clientWidth,
      };
    });
    expect(overflow.page).toBe(0);
    expect(overflow.header).toBe(0);

    // The right-most controls are FULLY visible (ratio 1 — a partially
    // clipped Panic/Vol would still intersect the viewport and pass at the
    // default ratio).
    await expect(page.getByTestId('panic')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('knob-master.volume')).toBeInViewport({ ratio: 1 });
    await expect(page.getByText('MIXER', { exact: true })).toBeInViewport();

    // ≤1140px drops the "Preset:" text label; the dropdown itself stays (REQ-8).
    await expect(page.getByText('Preset:', { exact: true })).toBeHidden();
    await expect(page.getByTestId('preset-select')).toBeVisible();

    // Two-row layout (REQ-9): the transport cluster leads the second row at
    // the far left; the voicing cluster right-aligns on it.
    const headerBox = (await page.getByTestId('app-header').boundingBox())!;
    const presetBox = (await page.getByTestId('preset-select').boundingBox())!;
    const playBox = (await page.getByTestId('transport-play').boundingBox())!;
    const volBox = (await page.getByTestId('knob-master.volume').boundingBox())!;
    expect(playBox.y).toBeGreaterThanOrEqual(presetBox.y + presetBox.height);
    expect(playBox.x).toBeLessThan(headerBox.x + 32);
    expect(volBox.x + volBox.width).toBeGreaterThan(headerBox.x + headerBox.width - 32);
    // Same row: transport and voicing overlap vertically.
    expect(volBox.y).toBeLessThan(playBox.y + playBox.height);

    // Preset-cluster split (REQ-10): dropdown + Save left, the utility icon
    // buttons far right of the first row (Fullscreen is the last of them).
    const saveBox = (await page.getByTestId('preset-save').boundingBox())!;
    const fullBox = (await page.getByTestId('fullscreen').boundingBox())!;
    expect(fullBox.x + fullBox.width).toBeGreaterThan(headerBox.x + headerBox.width - 32);
    // Same row as the dropdown, with a real gap between Save and the icons.
    expect(fullBox.y).toBeLessThan(presetBox.y + presetBox.height);
    expect((await page.getByTestId('perf-settings').boundingBox())!.x)
      .toBeGreaterThan(saveBox.x + saveBox.width + 100);

    // The wrapped header row pushes the panel grid down rather than painting
    // over it (the .app grid's fixed 80px header track must go auto ≤1140px).
    const panic = (await page.getByTestId('panic').boundingBox())!;
    const osc1 = (await page.getByText('OSC 1', { exact: true }).boundingBox())!;
    expect(panic.y + panic.height).toBeLessThanOrEqual(osc1.y);
  });
});
