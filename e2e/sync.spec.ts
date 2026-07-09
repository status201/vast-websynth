import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * MIDI clock sync — UI presence + persistence only. Headless Chromium has no
 * MIDI ports, so the status line reads "No MIDI ports" (access granted, empty
 * port maps) or "MIDI unavailable" (permission denied); nothing timing-related
 * can run here — the follow/broadcast math is unit-tested
 * (tests/audio/transport/sync/*).
 */
test('Song tab shows the Sync section; mode persists across reload', async ({ page }) => {
  await gotoAndStart(page);

  await page.getByRole('button', { name: 'Song', exact: true }).click();

  // Section present, with the degraded-gracefully status (REQ-9).
  const status = page.getByTestId('sync-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveText(/No MIDI ports|MIDI unavailable/);

  // Off is the default mode.
  await expect(page.getByTestId('sync-mode-off')).toHaveClass(/\bactive\b/);

  // Select Slave; it activates immediately.
  await page.getByTestId('sync-mode-slave').click();
  await expect(page.getByTestId('sync-mode-slave')).toHaveClass(/\bactive\b/);

  // Device-scoped persistence (websynth.midisync): survives a reload.
  await page.reload();
  await page.getByRole('button', { name: 'Tap to start' }).click();
  await page.getByRole('button', { name: 'Song', exact: true }).click();
  await expect(page.getByTestId('sync-mode-slave')).toHaveClass(/\bactive\b/);
});
