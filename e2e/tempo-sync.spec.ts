import { test, expect } from '@playwright/test';
import { startAudio } from './helpers';

/**
 * The BPM-aware "sweet spots" info badges (tempo-sync-help feature). Toggle the
 * help-mode badges, open the Delay Time badge, and confirm it lists the note
 * divisions at the live tempo and snaps the knob when a value is clicked.
 */

type Bridge = { __synth: { bus: { get(id: string): number; set(id: string, v: number): void } } };

test('Delay Time badge lists BPM sweet spots and snaps the knob', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1'); // suppress auto-tour
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await startAudio(page);
  await expect(page.getByTestId('tour-callout')).toBeHidden();

  // Pin a known tempo so the ms values are deterministic.
  await page.evaluate(() => (window as unknown as Bridge).__synth.bus.set('transport.bpm', 120));

  await page.getByTestId('info-badges').click();

  const badge = page.getByTestId('info-badge-fx.delay.time');
  await expect(badge).toBeVisible();
  await badge.click();

  const dialog = page.getByRole('dialog', { name: 'Delay Time' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('120 BPM');
  await expect(dialog).toContainText('375 ms'); // dotted eighth
  await expect(dialog).toContainText('500 ms'); // quarter note

  // Clicking the 1/8 row snaps the knob to 0.25 s and closes the modal.
  await dialog.getByTestId('sweet-fx.delay.time-18').click();
  await expect(dialog).toBeHidden();
  const value = await page.evaluate(() => (window as unknown as Bridge).__synth.bus.get('fx.delay.time'));
  expect(value).toBeCloseTo(0.25, 5);

  // Reopening after a tempo change refreshes the values (250 → different ms).
  await page.evaluate(() => (window as unknown as Bridge).__synth.bus.set('transport.bpm', 90));
  await badge.click();
  const dialog2 = page.getByRole('dialog', { name: 'Delay Time' });
  await expect(dialog2).toContainText('90 BPM');
  await expect(dialog2).toContainText('333 ms'); // 1/8 at 90 BPM = 0.3333 s
});
