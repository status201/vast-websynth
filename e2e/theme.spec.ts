// UI themes: the picker applies and stores a theme, and a reload puts it on the
// page before any stylesheet — no flash of Dark (specs/features/ui-themes.md
// REQ-the-theme-applies-before-first-paint, REQ-choosing-a-theme-previews-it).
import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * Record, before any page script runs, what the page looked like the first time
 * `data-theme` was set: its value, and how many stylesheets existed by then. A
 * MutationObserver's callback runs at the microtask checkpoint right after the
 * boot script, before the parser reaches the stylesheet links below it.
 */
const watchFirstTheme = () => {
  const w = window as unknown as { __firstTheme?: { theme: string | null; sheets: number } };
  new MutationObserver((_records, obs) => {
    if (w.__firstTheme) return;
    w.__firstTheme = {
      theme: document.documentElement.getAttribute('data-theme'),
      sheets: document.querySelectorAll('link[rel="stylesheet"], style').length,
    };
    obs.disconnect();
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme'] });
};

test('a picked theme applies at once, survives a reload, and is on the page before the first stylesheet', async ({ page }) => {
  await gotoAndStart(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByTestId('perf-settings').click();
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => localStorage.getItem('websynth.ui.theme'))).toBe('light');
  // The page itself changed colour, not just an attribute.
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe('rgb(14, 10, 6)');

  await page.addInitScript(watchFirstTheme);
  await page.reload();
  const first = await page.evaluate(() => (window as unknown as { __firstTheme?: unknown }).__firstTheme);
  expect(first).toEqual({ theme: 'light', sheets: 0 });
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light');
});

test('the picker is one radio group for the keyboard', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('perf-settings').click();
  await page.getByTestId('theme-dark').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('theme-light')).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('theme-auto')).toBeFocused();
  // Escape still belongs to the dialog.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('theme-picker')).toBeHidden();
});
