import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * dropdown.md REQ-an-open-menu-stays-under-the-sticky-header (v17, regression):
 * the `.app` section holding an open menu is raised above its sibling sections
 * but not above the sticky header. At z-index 100 the whole section painted
 * over the header, so opening the LFO destination with the page scrolled made
 * the header vanish. Hit-tested rather than read from computed style: the
 * failure is what paints on top, and that is the stacking of two contexts.
 */

/** Whether what paints topmost at the centre of `el` is part of it. */
const paintsOnTop = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && el.contains(hit);
};

const headerOnTop = (page: Page) =>
  page.getByTestId('app-header').evaluate(paintsOnTop);

test('opening a menu leaves the sticky header on top', async ({ page }) => {
  await page.setViewportSize({ width: 1150, height: 600 });
  await gotoAndStart(page);

  const toggle = page.getByTestId('dropdown-lfo.dest').locator('button').first();
  // Scrolled, so the sticky header overlaps the synth panels' section.
  await toggle.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  expect(await page.evaluate(() => document.body.scrollTop + document.documentElement.scrollTop))
    .toBeGreaterThan(0);
  expect(await headerOnTop(page)).toBe(true);

  await toggle.click();
  const lastOption = page.getByTestId('dropdown-lfo.dest').locator('.dropdown-option').last();
  await expect(lastOption).toBeVisible();

  expect(await headerOnTop(page), 'the header stays on top').toBe(true);
  expect(await lastOption.evaluate(paintsOnTop), 'the menu stays above the FX section').toBe(true);
});
