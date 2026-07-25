import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const clockStep = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.clock.step);
const playing = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).__synth.engine.clock.playing);
const setSeqChain = (page: Page, steps: number[]): Promise<void> =>
  page.evaluate((s) => (window as any).__synth.engine.arrangement.setSeqChain(s, true), steps);

const SEQ_LENGTH = 16;

/**
 * The Song panel's compact transport row and the TRANSPORT floating window
 * (transport-window.md).
 */
test.describe('TRANSPORT window', () => {
  test('the Song panel carries a compact transport row', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    await expect(page.getByTestId('transport-open')).toBeVisible();
    await expect(page.getByTestId('transport-tostart')).toBeVisible();
    await expect(page.getByTestId('transport-readout')).toHaveText('1.01');
    await expect(page.getByTestId('transport-scrub')).toBeVisible();
    // Play/Stop, BPM and SWING live in the window, not here (REQ-4). Note the
    // builder's toggle is `-toggle`, never `-play`: `transport-play` is the
    // header's own button, which must stay the one and only holder of that id.
    await expect(page.getByTestId('transport-toggle')).toHaveCount(0);
    await expect(page.getByTestId('transport-play')).toHaveCount(1);
  });

  test('the launcher opens a window with the full control set, live off the Song tab', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('transport-open').click();

    const win = page.getByTestId('transport-window');
    await expect(win).toBeVisible();
    await expect(win.getByTestId('transportw-toggle')).toBeVisible();
    await expect(win.getByTestId('transportw-tostart')).toBeVisible();
    await expect(win.getByTestId('transportw-readout')).toBeVisible();
    await expect(win.getByTestId('transportw-scrub')).toBeVisible();
    await expect(win.getByTestId('knob-transport.bpm')).toBeVisible();

    // Floating windows mount on document.body, so it survives a tab switch.
    await page.getByTestId('tab-seq').click();
    await expect(win).toBeVisible();
  });

  test('the window Play button and the header stay in sync', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('transport-open').click();

    const winPlay = page.getByTestId('transportw-toggle');
    const headerPlay = page.getByTestId('transport-play'); // the header's own button
    await winPlay.click();
    await expect.poll(() => playing(page)).toBe(true);
    await expect(winPlay).toHaveText('Stop');
    await expect(headerPlay).toHaveText('Stop');

    // Stopping from the header must move the window's button too — one
    // transport, not two (transport-window.md REQ-5).
    await headerPlay.click();
    await expect.poll(() => playing(page)).toBe(false);
    await expect(winPlay).toHaveText('Play');
  });

  test('the scrubber spans the song and jumps to a bar', async ({ page }) => {
    await gotoAndStart(page);
    await setSeqChain(page, [0, 0, 1, 0]); // four bars
    await page.getByTestId('tab-song').click();

    const cells = page.locator('[data-testid="transport-scrub"] button');
    await expect(cells).toHaveCount(4);

    await page.getByTestId('transport-scrub-2').click();
    expect(await clockStep(page)).toBe(SEQ_LENGTH * 2);
    await expect(page.getByTestId('transport-readout')).toHaveText('3.01');
  });

  test('the return-to-start button goes back to bar 1', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.evaluate((n) => (window as any).__synth.engine.seekTo(n), SEQ_LENGTH * 5 + 7);
    await expect(page.getByTestId('transport-readout')).toHaveText('6.08');

    await page.getByTestId('transport-tostart').click();
    expect(await clockStep(page)).toBe(0);
    await expect(page.getByTestId('transport-readout')).toHaveText('1.01');
  });

  test('the readout agrees with the machine-tab ruler', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('ruler-drum-10').click();
    await page.getByTestId('tab-song').click();
    // Both surfaces answer "where are we?" from the same number.
    await expect(page.getByTestId('transport-readout')).toHaveText('1.11');
  });
});
