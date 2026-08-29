import { test, expect } from '@playwright/test';
import { startAudio } from './helpers';

/**
 * Installed-PWA affordances (specs/features/pwa-install.md) — the slice
 * observable on the dev server in headless Chromium:
 *  - the header fullscreen toggle (Chromium has the Fullscreen API),
 *  - NO service worker on the dev server (registration is PROD-gated —
 *    a SW here would poison Vite HMR and every other spec).
 * Wake lock, launchQueue and the manifest fields are covered by unit tests
 * (tests/utils/wake-lock.test.ts, tests/pwa/sw.test.ts) and manual passes.
 */
test('fullscreen button toggles; no service worker on the dev server', async ({ page }) => {
  await page.goto('/');
  await startAudio(page);

  // PROD-gated registration: the dev server must never be SW-controlled.
  const controller = await page.evaluate(() => navigator.serviceWorker?.controller ?? null);
  expect(controller).toBeNull();

  // Fullscreen toggle — a trusted click, so requestFullscreen resolves.
  const btn = page.getByTestId('fullscreen');
  await expect(btn).toBeVisible();
  await btn.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(btn).toHaveClass(/\bon\b/);

  await btn.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  await expect(btn).not.toHaveClass(/\bon\b/);
});
