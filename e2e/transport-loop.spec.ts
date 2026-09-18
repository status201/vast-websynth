import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busSet, pickDemo, clickDemo } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SEQ_LENGTH = 16;

const setSeqChain = (page: Page, steps: number[]): Promise<void> =>
  page.evaluate((s) => (window as any).__synth.engine.arrangement.setSeqChain(s, true), steps);
const playing = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).__synth.engine.clock.playing);
const cue = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.clock.cue);
const loopRange = (page: Page): Promise<{ start: number; end: number } | null> =>
  page.evaluate(() => (window as any).__synth.engine.loop.range);

/** Record every emitted step from here on. */
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

const inLoop = (page: Page): Promise<boolean[]> =>
  page.locator('[data-testid="transport-scrub"] button')
    .evaluateAll((cells) => cells.map((c) => c.classList.contains('loop')));

/**
 * transport-loop.md — the Loop button, the two scrubber picks and the bar-line
 * wrap, through the real Worker-driven clock in Chromium.
 */
test.describe('Transport loop', () => {
  test('two picks loop the bars between them', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'transport.bpm', 240); // a 16th every 62.5 ms: two passes in ~4 s
    await setSeqChain(page, [0, 1, 0, 1]); // four bars
    await page.getByTestId('tab-song').click();

    const loopBtn = page.getByTestId('transport-loop');
    await loopBtn.click();
    await expect(loopBtn).toHaveClass(/(^|\s)on(\s|$)/);
    await expect(loopBtn).toHaveAttribute('aria-pressed', 'true');

    // REQ-with-loop-on-a-click-picks-a-bar: while Loop is on a click picks — it does not move the playhead.
    await page.getByTestId('transport-scrub-2').click();
    await expect(page.getByTestId('transport-scrub-2')).toHaveClass(/loop-anchor/);
    expect(await cue(page)).toBe(0);
    await page.getByTestId('transport-scrub-1').click();
    expect(await loopRange(page)).toEqual({ start: 1, end: 2 });
    expect(await inLoop(page)).toEqual([false, true, true, false]);
    // REQ-turning-loop-on-moves-the-cue: stopped and outside it, the cue moved in — Play starts in the loop.
    expect(await cue(page)).toBe(SEQ_LENGTH);
    await expect(page.getByTestId('transport-readout')).toHaveText('2.01');

    await recordTicks(page);
    await page.getByTestId('transport-toggle').click();
    await expect.poll(async () => (await ticks(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(SEQ_LENGTH * 2 + 8);
    await page.getByTestId('transport-toggle').click(); // Pause
    await expect.poll(() => playing(page)).toBe(false);

    const run = await ticks(page);
    expect(run[0]).toBe(SEQ_LENGTH);
    // Never outside bars 2–3, and the last step of bar 3 is followed by bar 2's first.
    expect(run.every((s) => s >= SEQ_LENGTH && s < SEQ_LENGTH * 3)).toBe(true);
    const i = run.indexOf(SEQ_LENGTH * 3 - 1);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(run[i + 1]).toBe(SEQ_LENGTH);
  });

  test('Loop off keeps the range dimmed, and the scrubber seeks again', async ({ page }) => {
    await gotoAndStart(page);
    await setSeqChain(page, [0, 1, 0, 1]);
    await page.getByTestId('tab-song').click();

    const loopBtn = page.getByTestId('transport-loop');
    await loopBtn.click();
    await page.getByTestId('transport-scrub-1').click();
    await page.getByTestId('transport-scrub-2').click();
    await loopBtn.click(); // off
    await expect(loopBtn).toHaveAttribute('aria-pressed', 'false');
    expect(await inLoop(page)).toEqual([false, true, true, false]); // remembered (REQ-turning-loop-off-keeps-the-range)
    expect(await loopRange(page)).toEqual({ start: 1, end: 2 });

    await page.getByTestId('transport-scrub-3').click();
    expect(await cue(page)).toBe(SEQ_LENGTH * 3); // a seek, not a pick
  });

  // song-mode.md REQ-a-load-lands-on-bar-one (v26) / transport-loop.md REQ-loading-a-song-clears-the-loop.
  test('loading a song clears the loop', async ({ page }) => {
    await gotoAndStart(page);
    await setSeqChain(page, [0, 1, 0, 1]);
    await page.getByTestId('tab-song').click();

    await page.getByTestId('transport-loop').click();
    await page.getByTestId('transport-scrub-1').click();
    await page.getByTestId('transport-scrub-2').click();
    expect(await loopRange(page)).not.toBeNull();

    // A built-in applies synchronously. Which one is irrelevant — never name it.
    await clickDemo(page, (await pickDemo(page, 'built-in')).name);
    await expect(page.getByTestId('transport-loop')).toHaveAttribute('aria-pressed', 'false');
    expect(await loopRange(page)).toBeNull();
    await expect(page.locator('[data-testid="transport-scrub"] button.loop')).toHaveCount(0);
    await expect(page.getByTestId('transport-readout')).toHaveText('1.01');
  });
});
