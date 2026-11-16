import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * The sample studio's Record screen: capture from the mic, edit, and load into a
 * Sampler slot (sample-recorder.md). Chromium runs with
 * `--use-fake-device/ui-for-media-stream` (see playwright.config.ts), so
 * getUserMedia resolves with a synthetic audio stream — no real hardware or
 * permission prompt. localhost is a secure context, which the studio requires.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
test.describe('mic recording', () => {
  test('record from the fake mic, edit, and load into a slot', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await page.getByTestId('sampler-record').click();
    const dialog = page.getByRole('dialog', { name: 'Record a sound' });
    await expect(dialog).toBeVisible();

    // The mic opens with the screen (REQ-the-mic-opens-with-the-studio).
    const rec = page.getByTestId('mic-record-toggle');
    await expect(rec).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('mic-meter')).toBeVisible();

    await rec.click();
    await expect(rec).toHaveAttribute('data-state', 'recording');
    await expect(page.getByTestId('mic-timer')).toContainText('REC');
    await page.waitForTimeout(400); // capture a few hundred ms of frames
    await rec.click();

    // The Edit screen: apply one effect, then load into the first empty slot.
    await expect(page.getByTestId('rec-screen-edit')).toBeVisible();
    await page.getByTestId('mic-fx-normalize').click();
    await expect(page.getByTestId('mic-load')).toHaveText(/Load into S1/);
    await page.getByTestId('mic-load').click();

    // Studio closed and slot 0 now holds a decoded buffer + a name.
    await expect(dialog).toBeHidden();
    const loaded = await page.evaluate(() => (window as any).__synth.engine.sampler.buffers[0] != null);
    expect(loaded).toBe(true);
    await expect(page.getByTestId('sampler-name-0')).toContainText('recording');
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();
    await expect(page.getByTestId('mic-load-toast')).toBeVisible();
  });

  test('the song stops from inside the studio, which stays open (REQ-the-transport-is-in-reach)', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('sampler-record').click();
    const dialog = page.getByRole('dialog', { name: 'Record a sound' });
    await expect(page.getByTestId('mic-record-toggle')).toHaveAttribute('data-state', 'ready');

    const playing = () => page.evaluate(() => (window as any).__synth.engine.clock.playing as boolean);
    const toggle = page.getByTestId('rec-transport-toggle');
    await toggle.click();
    await expect.poll(playing).toBe(true);
    await expect(toggle).toHaveText(/Stop/);
    await toggle.click();
    await expect.poll(playing).toBe(false);
    await expect(dialog).toBeVisible();
  });

  test('a take is never thrown away without asking (REQ-nothing-closes-the-studio-by-accident)', async ({ page, context }) => {
    await context.grantPermissions(['microphone']);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('sampler-record').click();
    const dialog = page.getByRole('dialog', { name: 'Record a sound' });
    const rec = page.getByTestId('mic-record-toggle');
    await expect(rec).toHaveAttribute('data-state', 'ready');
    await rec.click();
    await page.waitForTimeout(300);
    await rec.click();
    await expect(page.getByTestId('rec-screen-edit')).toBeVisible();

    // A click outside the card does nothing.
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();

    // Escape asks; keeping the take keeps it.
    await page.keyboard.press('Escape');
    await page.getByTestId('dialog-cancel').click();
    await expect(dialog).toBeVisible();

    // Discarding it closes — and the next open offers it back.
    await page.getByTestId('mic-close').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(dialog).toBeHidden();
    await page.getByTestId('sampler-record').click();
    await page.getByTestId('rec-restore').click();
    await expect(page.getByTestId('rec-screen-edit')).toBeVisible();
  });
});
