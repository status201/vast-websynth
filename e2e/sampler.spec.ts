import { test, expect } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

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

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const loaded = await page.evaluate(() => (window as any).__synth.engine.sampler.buffers[0] != null);
    expect(loaded).toBe(true);
  });
});
