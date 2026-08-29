import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, startAudio, busGet, busSet } from './helpers';

/** The running sync role, via the dev-only `window.__synth` bridge. */
const syncActiveMode = (page: Page): Promise<string> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.evaluate(() => (window as any).__synth.engine.sync.activeMode as string);

/**
 * MIDI clock sync — UI presence + persistence only. Headless Chromium has no
 * MIDI ports, so the status line reads "No MIDI ports" (access granted, empty
 * port maps) or "MIDI unavailable" (permission denied); nothing timing-related
 * can run here — the follow/broadcast math is unit-tested
 * (tests/audio/transport/sync/*). The real WiFi loopback lives in
 * webrtc-sync.spec.ts.
 */
test('Song tab shows the Sync section; mode persists across reload', async ({ page }) => {
  await gotoAndStart(page);

  await page.getByRole('button', { name: 'Song', exact: true }).click();

  // Section present, with the degraded-gracefully status (REQ-9). The WiFi
  // transport is always added, so the status line carries its (unlinked) suffix.
  const status = page.getByTestId('sync-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveText(/(No MIDI ports|MIDI unavailable).*WiFi: not linked/);

  // The WiFi pairing entry point is present (opens the serverless pair modal).
  await expect(page.getByTestId('sync-wifi-link')).toBeVisible();

  // Off is the default mode.
  await expect(page.getByTestId('sync-mode-off')).toHaveClass(/\bactive\b/);

  // Select Slave; it becomes the selected segment immediately.
  await page.getByTestId('sync-mode-slave').click();
  await expect(page.getByTestId('sync-mode-slave')).toHaveClass(/\bactive\b/);

  // ...but with no MIDI input and no WiFi peer there is nothing to follow, so
  // the role is *armed*, not running (midi-clock-sync REQ-19/22). This is the
  // end-to-end guard against the "disconnected slave freezes the BPM knob" bug.
  await expect(page.getByTestId('sync-mode-slave')).toHaveClass(/\barmed\b/);
  await expect(status).toContainText('Slave armed');
  await expect(page.getByTestId('knob-transport.bpm')).not.toHaveAttribute('aria-disabled', 'true');
  expect(await syncActiveMode(page)).toBe('off');

  // The tempo really is still ours: bus writes are not swallowed by the gate.
  await busSet(page, 'transport.bpm', 150);
  expect(await busGet(page, 'transport.bpm')).toBe(150);

  // Device-scoped persistence (websynth.midisync): survives a reload.
  await page.reload();
  await startAudio(page);
  await page.getByRole('button', { name: 'Song', exact: true }).click();
  await expect(page.getByTestId('sync-mode-slave')).toHaveClass(/\bactive\b/);
});
