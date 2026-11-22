import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/**
 * The sample studio's Vocoder tab (vocoder.md) in a real browser: a voice take
 * from the fake mic (`--use-fake-device-for-media-stream`, playwright.config.ts)
 * recorded against the clip, then applied and undone. Whether it SOUNDS right is
 * judged by ear (ADR-010); this pins that the take runs end to end.
 */

/** Load a short clip into slot 0 and open it on the Vocoder tab. */
async function openVocoder(page: Page): Promise<void> {
  await gotoAndStart(page);
  await page.getByTestId('tab-sampler').click();
  await page.getByTestId('sampler-file-0').setInputFiles({
    name: 'pad.wav', mimeType: 'audio/wav', buffer: makeWavBuffer(0.5),
  });
  await expect(page.getByTestId('sampler-name-0')).toHaveText('pad.wav');
  await page.getByTestId('sampler-edit-0').click();
  await expect(page.getByTestId('rec-screen-edit')).toBeVisible();
  await page.getByTestId('ptab-sample-vocoder').click();
  await expect(page.getByTestId('ppage-sample-vocoder')).toBeVisible();
}

test.describe('sample studio — vocoder', () => {
  test('a mic voice take runs end to end, applies and undoes (REQ-the-voice-take-follows-the-carrier)', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await openVocoder(page);
    await expect(page.getByTestId('voc-apply')).toBeDisabled();

    const rec = page.getByTestId('voc-record');
    await rec.click();
    // Cue (the half-second clip once), then the pass, then it stops itself.
    await expect(rec).toHaveAttribute('data-state', /cue|take/);
    await expect(rec).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
    await expect(page.getByTestId('voc-state')).toContainText('Mic take');
    await expect(page.getByTestId('voc-apply')).toBeEnabled();

    await page.getByTestId('voc-apply').click();
    await expect(page.getByTestId('mic-status')).toContainText('Vocode applied');
    await page.getByTestId('mic-undo').click();
    await expect(page.getByTestId('mic-status')).toContainText('Undone');
  });
});
