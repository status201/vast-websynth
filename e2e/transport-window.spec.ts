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

/** Record every emitted step, so a test can read where playback (re)started. */
const recordTicks = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as any;
    w.__ticks = [];
    if (!w.__tickRecorder) {
      w.__tickRecorder = w.__synth.engine.clock.onTick((s: number) => { w.__ticks.push(s); });
    }
  });
const ticks = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as any).__ticks as number[]);

/**
 * The Song panel's transport row and the TRANSPORT floating window
 * (transport-window.md) — the same control set on both since v5.
 */
test.describe('TRANSPORT window', () => {
  test('the Song panel carries the full transport row (v5)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    await expect(page.getByTestId('transport-open')).toBeVisible();
    await expect(page.getByTestId('transport-toggle')).toHaveText('Play');
    await expect(page.getByTestId('transport-tostart')).toBeVisible();
    await expect(page.getByTestId('transport-readout')).toHaveText('1.01');
    await expect(page.getByTestId('transport-loop')).toBeVisible();
    await expect(page.getByTestId('transport-scrub')).toBeVisible();
    // The builder's toggle is `-toggle`, never `-play`: `transport-play` is the
    // header's own button, which must stay the one and only holder of that id.
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
    await expect(win.getByTestId('transportw-loop')).toBeVisible();
    await expect(win.getByTestId('transportw-scrub')).toBeVisible();
    // REQ-transport-is-a-floating-window: BPM/SWING are the header's alone. A copy here would be a second
    // control for one param that does not know to disable itself while slaved —
    // and a duplicate testid that breaks strict-mode locators elsewhere.
    await expect(win.getByTestId('knob-transport.bpm')).toHaveCount(0);
    await expect(win.getByTestId('knob-transport.swing')).toHaveCount(0);
    await expect(page.getByTestId('knob-transport.bpm')).toHaveCount(1);

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
    // v5: the song transport pauses; the header still stops (REQ-pause-and-stop-are-separate-verbs).
    await expect(winPlay).toHaveText('Pause');
    await expect(headerPlay).toHaveText('Stop');

    // Stopping from the header must move the window's button too — one
    // transport, not two (transport-window.md REQ-play-pause-is-not-a-second-truth).
    await headerPlay.click();
    await expect.poll(() => playing(page)).toBe(false);
    await expect(winPlay).toHaveText('Play');
  });

  // REQ-pause-and-stop-are-separate-verbs (v5) / transport.md REQ-pause-resumes-where-it-stopped — Pause stays here; Stop goes back.
  test('Pause resumes where playback was; the header Stop still returns to the cue', async ({ page }) => {
    await gotoAndStart(page);
    await setSeqChain(page, [0, 0, 1, 0]); // four bars
    await page.getByTestId('tab-song').click();
    const toggle = page.getByTestId('transport-toggle');

    await toggle.click();
    await expect.poll(() => playing(page)).toBe(true);
    await expect(toggle).toHaveText('Pause');
    await expect.poll(() => clockStep(page), { timeout: 10_000 }).toBeGreaterThan(SEQ_LENGTH + 4);

    await toggle.click();
    await expect.poll(() => playing(page)).toBe(false);
    await expect(toggle).toHaveText('Play');
    const resumeAt = await page.evaluate(() => (window as any).__synth.engine.clock.cue as number);
    expect(resumeAt).toBeGreaterThan(SEQ_LENGTH + 4);
    // Stopped, the readout names where Play will continue — not bar 1.
    const bar = Math.floor(resumeAt / SEQ_LENGTH);
    const step = resumeAt % SEQ_LENGTH;
    await expect(page.getByTestId('transport-readout'))
      .toHaveText(`${(bar % 4) + 1}.${String(step + 1).padStart(2, '0')}`);

    await recordTicks(page);
    await toggle.click();
    await expect.poll(async () => (await ticks(page)).length).toBeGreaterThan(0);
    expect((await ticks(page))[0]).toBe(resumeAt); // nothing repeated, nothing skipped

    // The header's Stop is the other verb: back to the cue (never seeked: bar 1).
    await page.getByTestId('transport-play').click();
    await expect.poll(() => playing(page)).toBe(false);
    await expect(page.getByTestId('transport-readout')).toHaveText('1.01');
    await recordTicks(page);
    await toggle.click();
    await expect.poll(async () => (await ticks(page)).length).toBeGreaterThan(0);
    expect((await ticks(page))[0]).toBe(0);
    await page.getByTestId('transport-play').click();
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
    // An eight-bar chain, so bar 6 is a bar the song actually has: the readout
    // wraps at song length (REQ-the-position-readout-is-bar-dot-step) and would otherwise report bar 1 here.
    await setSeqChain(page, [0, 0, 1, 0, 0, 0, 1, 0]);
    await page.getByTestId('tab-song').click();
    await page.evaluate((n) => (window as any).__synth.engine.seekTo(n), SEQ_LENGTH * 5 + 7);
    await expect(page.getByTestId('transport-readout')).toHaveText('6.08');

    await page.getByTestId('transport-tostart').click();
    expect(await clockStep(page)).toBe(0);
    await expect(page.getByTestId('transport-readout')).toHaveText('1.01');
  });

  // REQ-the-position-readout-is-bar-dot-step (regression): the readout printed the ABSOLUTE bar, so with no chain
  // enabled — the default — it counted 1.01, 2.01, 3.01 … beside a scrubber that
  // had exactly one cell. The two now name the same bar by construction.
  test('the readout never counts a bar the song does not have', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await expect(page.locator('[data-testid="transport-scrub"] button')).toHaveCount(1);

    await page.evaluate((n) => (window as any).__synth.engine.seekTo(n), SEQ_LENGTH * 36 + 4);
    await expect(page.getByTestId('transport-readout')).toHaveText('1.05');
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
