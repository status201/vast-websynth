import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const slotLoaded = (page: Page, slot: number): Promise<boolean> =>
  page.evaluate((s) => (window as any).__synth.engine.sampler.buffers[s] != null, slot);

/**
 * Loading a WAV via the hidden file input decodes it (decodeAudioData), fills
 * the slot's AudioBuffer, updates the filename label, and reveals the ✎ edit
 * button (hidden until a buffer is present).
 */
test.describe('sampler', () => {
  test('loading a WAV file fills the slot', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await expect(page.getByTestId('sampler-edit-0')).toBeHidden();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });

    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();

    expect(await slotLoaded(page, 0)).toBe(true);
  });

  /**
   * sample-persistence.md — the clip itself (not just its name) is persisted in
   * IndexedDB, so a reload brings the audio back with no `.needs-reload` hint
   * and nothing to re-pick from disk.
   */
  test('a loaded clip survives a reload', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');

    // The session autosave (1.5 s) carries the NAME; the clip store (0.8 s)
    // carries the audio. Both must have landed before the reload.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('websynth.session')), { timeout: 5000 })
      .not.toBeNull();

    // Same context ⇒ localStorage and IndexedDB both survive.
    await page.reload();
    await page.getByRole('button', { name: 'Tap to start' }).click();
    await page.getByTestId('tab-sampler').click();

    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-name-0')).not.toHaveClass(/needs-reload/);
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();
    expect(await slotLoaded(page, 0)).toBe(true);
    // …and the user is told the audio came from storage, not the song file.
    await expect(page.getByTestId('clips-restored-toast')).toContainText('1 sampler clip');
  });
});
