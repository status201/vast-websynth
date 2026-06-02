import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * The "Record a sound" modal: capture from the mic, edit, and load into a
 * Sampler slot. Chromium runs with `--use-fake-device/ui-for-media-stream`
 * (see playwright.config.ts), so getUserMedia resolves with a synthetic audio
 * stream — no real hardware or permission prompt. localhost is a secure
 * context, which the modal requires.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
test.describe('mic recording', () => {
  test('record from the fake mic, edit, and load into a slot', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    // Open the modal.
    await page.getByTestId('sampler-record').click();
    const dialog = page.getByRole('dialog', { name: 'Record a sound' });
    await expect(dialog).toBeVisible();

    // Record a brief clip from the fake device, then stop → enters the editor.
    const rec = page.getByTestId('mic-record-toggle');
    await rec.click();
    await expect(rec).toHaveText(/Stop/); // label flips once the mic is armed
    await page.waitForTimeout(400); // capture a few hundred ms of frames
    await rec.click();

    // Editor is shown (effects available). Apply one, then load to slot 0.
    await expect(page.getByTestId('mic-fx-normalize')).toBeVisible();
    await page.getByTestId('mic-fx-normalize').click();
    await page.getByTestId('mic-load').click();

    // Modal closed and slot 0 now holds a decoded buffer + a name.
    await expect(dialog).toBeHidden();
    const loaded = await page.evaluate(() => (window as any).__synth.engine.sampler.buffers[0] != null);
    expect(loaded).toBe(true);
    await expect(page.getByTestId('sampler-name-0')).toContainText('recording');
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();
  });
});
