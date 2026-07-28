import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoAndStart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const phase = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).__synth.engine.recorder.phase);

/**
 * The RECORD floating window (record-window.md) against the real recorder —
 * the worklet, the phase machine and a genuinely downloaded file.
 */
test.describe('Record window', () => {
  test('records, pauses and stops without writing anything until you save', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-record').click();

    const win = page.getByTestId('record-window');
    await expect(win).toBeVisible();
    await expect(page.getByTestId('record-timer')).toHaveText('0:00');
    await expect(page.getByTestId('record-stop')).toBeDisabled();

    await page.getByTestId('record-toggle').click();
    await expect.poll(() => phase(page)).toBe('recording');
    await expect(page.getByTestId('record-toggle')).toHaveText('Pause');

    // The timer must actually advance — it is the whole point of the window.
    await expect.poll(
      () => page.getByTestId('record-timer').textContent(),
      { timeout: 5000 },
    ).not.toBe('0:00');

    await page.getByTestId('record-toggle').click();
    await expect.poll(() => phase(page)).toBe('paused');
    await expect(page.getByTestId('record-toggle')).toHaveText('Resume');
    // Pausing the RECORDER leaves the transport alone (REQ-3).
    expect(await page.evaluate(() => (window as any).__synth.engine.clock.playing)).toBe(true);

    await page.getByTestId('record-toggle').click();
    await page.getByTestId('record-stop').click();
    await expect.poll(() => phase(page)).toBe('review');
    // REQ-4: stopping writes nothing. Save/Discard replace Record/Stop.
    await expect(page.getByTestId('record-save')).toHaveText('Save as WAV');
    await expect(page.getByTestId('record-toggle')).toBeHidden();

    const dl = page.waitForEvent('download', { timeout: 20000 });
    await page.getByTestId('record-save').click();
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/\.wav$/);
    const head = readFileSync(await download.path());
    expect(head.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(head.subarray(8, 12).toString('ascii')).toBe('WAVE');
    await expect.poll(() => phase(page)).toBe('idle');
  });

  test('Discard throws the take away and writes nothing', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-record').click();
    await page.getByTestId('record-toggle').click();
    await page.waitForTimeout(400);
    await page.getByTestId('record-stop').click();
    await expect.poll(() => phase(page)).toBe('review');

    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await page.getByTestId('record-discard').click();
    await expect.poll(() => phase(page)).toBe('idle');
    await page.waitForTimeout(300);
    expect(downloaded).toBe(false);
  });

  test('stays live off the Song tab, and Shift+R toggles it from anywhere', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-record').click();
    await page.getByTestId('record-toggle').click();
    await expect.poll(() => phase(page)).toBe('recording');

    // Floating windows mount on document.body, so the take survives a tab move.
    await page.getByTestId('tab-seq').click();
    await expect(page.getByTestId('record-window')).toBeVisible();
    await expect(page.getByTestId('record-toggle')).toHaveText('Pause');

    // A free take does NOT lock the playhead (transport-position.md REQ-6 v3):
    // only an EXPORT bounds itself by absolute step. Asserted as the contract
    // plus its visible consequence — the landed step is not assertable, because
    // the transport is running and has moved on by the time we could read it.
    expect(await page.evaluate(() => (window as any).__synth.engine.canSeek())).toBe(true);
    await expect(page.getByTestId('ruler-seq-4')).toHaveAttribute('aria-disabled', 'false');
    expect(await page.evaluate(() => (window as any).__synth.engine.seekTo(4 * 16))).toBe(true);

    // Tidy up so the close confirm doesn't block the rest of the test.
    await page.getByTestId('record-stop').click();
    await page.getByTestId('record-discard').click();
    await expect.poll(() => phase(page)).toBe('idle');

    // Shift+R closes it from the Sequencer tab, and opens it again.
    await page.keyboard.press('Shift+R');
    await expect(page.getByTestId('record-window')).toBeHidden();
    await page.keyboard.press('Shift+R');
    await expect(page.getByTestId('record-window')).toBeVisible();
  });

  test('closing with an unsaved take asks first (REQ-8)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-record').click();
    const win = page.getByTestId('record-window');
    const closeBtn = win.getByRole('button', { name: 'Close' });

    await page.getByTestId('record-toggle').click();
    await page.waitForTimeout(300);
    await page.getByTestId('record-stop').click();
    await expect.poll(() => phase(page)).toBe('review');

    // Cancel keeps both the window and the take.
    await closeBtn.click();
    await expect(page.getByTestId('dialog-cancel')).toBeVisible();
    await page.getByTestId('dialog-cancel').click();
    await expect(win).toBeVisible();
    expect(await phase(page)).toBe('review');

    // Confirming discards it and closes.
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    await closeBtn.click();
    await page.getByTestId('dialog-confirm').click();
    await expect(win).toBeHidden();
    await expect.poll(() => phase(page)).toBe('idle');
  });

  test('an idle window closes with no dialog at all (edge)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-record').click();
    const win = page.getByTestId('record-window');
    await win.getByRole('button', { name: 'Close' }).click();
    await expect(win).toBeHidden();
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
  });
});
