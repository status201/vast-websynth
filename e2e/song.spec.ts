import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoAndStart, sessionDisplay } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const seqOn = (page: import('@playwright/test').Page, i: number): Promise<boolean> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[idx].on, i);

test.describe('song mode', () => {
  test('save → new → load round-trips pattern state via localStorage', async ({ page }) => {
    await gotoAndStart(page);

    // Make the pattern non-default.
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-step-5').click();
    expect(await seqOn(page, 5)).toBe(true);

    await page.getByTestId('tab-song').click();

    // Save names the song via the custom prompt dialog and also downloads a JSON copy.
    const jsonDownload = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await page.getByTestId('dialog-input').fill('e2e-song');
    await page.getByTestId('dialog-confirm').click();
    await jsonDownload; // consume the JSON download so it doesn't dangle
    const stored = await page.evaluate(() => localStorage.getItem('websynth.song.e2e-song'));
    expect(stored).not.toBeNull();

    // New clears all banks/chains (custom confirm dialog). The slot dropdown keeps
    // the saved name selected, so Load reloads it.
    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(() => seqOn(page, 5)).toBe(false);

    await page.getByTestId('song-load').click();
    await expect.poll(() => seqOn(page, 5)).toBe(true);
  });

  test('per-lane Clear confirms before wiping the arrangement chain', async ({ page }) => {
    await gotoAndStart(page);
    const seqSteps = () =>
      page.evaluate(() => (window as any).__synth.engine.arrangement.seq.steps.length);

    // Build a multi-step chain so Clear has something to lose.
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0, 1, 2, 3], false));
    await page.getByTestId('tab-song').click();
    expect(await seqSteps()).toBe(4);

    // Cancelling the confirm leaves the chain intact.
    await page.getByTestId('chain-clear-seq').click();
    await page.getByTestId('dialog-cancel').click();
    // Wait for the dialog to fully detach (200ms fade) before re-opening, so the
    // next getByTestId('dialog-confirm') is unambiguous.
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    expect(await seqSteps()).toBe(4);

    // Confirming resets it to a single bank.
    await page.getByTestId('chain-clear-seq').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(seqSteps).toBe(1);
  });

  test('loading a demo labels the preset selector with the song name', async ({ page }) => {
    await gotoAndStart(page);
    expect(await sessionDisplay(page)).toBe('basic');

    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-demo-Zombie Nation').click();

    await expect.poll(() => sessionDisplay(page)).toBe('Zombie Nation');
    await expect(page.getByTestId('preset-select')).toContainText('Zombie Nation');
  });

  test('Export Song renders and downloads a WAV', async ({ page }) => {
    await gotoAndStart(page);
    // Shorten the render to a single bar (default fallback is 4) via the bridge.
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0], true));

    await page.getByTestId('tab-song').click();
    const wavDownload = page.waitForEvent('download', { timeout: 20000 });
    await page.getByTestId('song-export-audio').click();
    const download = await wavDownload;

    expect(download.suggestedFilename()).toMatch(/\.wav$/);
    const path = await download.path();
    const head = readFileSync(path);
    expect(head.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(head.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });
});
