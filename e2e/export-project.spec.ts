import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const slotLoaded = (page: import('@playwright/test').Page, slot: number): Promise<boolean> =>
  page.evaluate((s) => (window as any).__synth.engine.sampler.buffers[s] != null, slot);
const slotName = (page: import('@playwright/test').Page, slot: number): Promise<string | null> =>
  page.evaluate((s) => (window as any).__synth.patterns.sampleNames[s], slot);

test.describe('project export', () => {
  test('fresh boot: Project row disabled with note; JSON export still downloads', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    await page.getByTestId('song-export').click();
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await expect(page.getByTestId('export-kind-project')).toBeDisabled();
    await expect(page.getByTestId('export-project-note')).toBeVisible();
    // Format toggle only belongs to the Project kind, which is not selectable here.
    await expect(page.getByTestId('export-fmt-wav')).toBeHidden();

    const jsonDownload = page.waitForEvent('download');
    await page.getByTestId('export-confirm').click();
    const download = await jsonDownload;
    expect(download.suggestedFilename()).toMatch(/\.websynth\.json$/);

    // The download is pretty-printed + newline-terminated — byte-identical to
    // `npm run clean:demos` output, so drop-ins to src/state/demos/ diff cleanly.
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text.startsWith('{\n  "format"')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + '\n');
  });

  test('project round-trip: export a zip, New, re-import — slot repopulates without needs-reload', async ({ page }) => {
    await gotoAndStart(page);

    // Load a WAV into sampler slot 0.
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'kick.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect.poll(() => slotLoaded(page, 0)).toBe(true);

    // Export → Project (WAV default) → the zip downloads.
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-export').click();
    await expect(page.getByTestId('export-kind-project')).toBeEnabled();
    await page.getByTestId('export-kind-project').click();
    await expect(page.getByTestId('export-fmt-wav')).toBeVisible();
    const zipDownload = page.waitForEvent('download');
    await page.getByTestId('export-confirm').click();
    const download = await zipDownload;
    expect(download.suggestedFilename()).toMatch(/\.websynth\.zip$/);

    // New wipes the slot (buffer + name).
    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(() => slotLoaded(page, 0)).toBe(false);
    await expect.poll(() => slotName(page, 0)).toBeNull();

    // Re-import the downloaded zip: the song applies AND the clip decodes back
    // into slot 0 — named, with NO needs-reload hint (the audio came along).
    await page.getByTestId('song-import-file').setInputFiles((await download.path())!);
    await expect.poll(() => slotLoaded(page, 0)).toBe(true);
    await expect.poll(() => slotName(page, 0)).toBe('kick.wav');
    await page.getByTestId('tab-sampler').click();
    await expect(page.getByTestId('sampler-name-0')).toHaveText('kick.wav');
    await expect(page.getByTestId('sampler-name-0')).not.toHaveClass(/needs-reload/);
  });
});
