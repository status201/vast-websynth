import { test, expect } from '@playwright/test';
import { gotoAndStart, busGet, busSet } from './helpers';

/**
 * Time signature + per-lane length/rate, end to end (specs/features/meter.md).
 *
 * jsdom can measure none of this: which cells a grid actually *draws* is a CSS
 * grid decision, and the ruler, the grid and the LEN/RATE hint agreeing is the
 * whole point of routing all three through `laneGrid` — so it is worth one real
 * browser.
 */

/** Pick a signature from the header's METER dropdown. */
async function pickMeter(page: import('@playwright/test').Page, label: string): Promise<void> {
  await page.getByTestId('meter-picker').locator('button').first().click();
  await page.getByTestId('meter-picker').locator('button')
    .filter({ hasText: new RegExp(`^${label.replace('/', '\\/')}$`) })
    .click();
}

const liveCells = (page: import('@playwright/test').Page, prefix: string): Promise<number> =>
  page.locator(`[data-testid^="${prefix}"]:visible`).count();

test.describe('meter', () => {
  test('the picker sets the pair, and every machine follows the bar', async ({ page }) => {
    await gotoAndStart(page);
    // Default is 4/4 — an untouched session must look exactly as it always did.
    expect(await busGet(page, 'transport.beats')).toBe(4);
    expect(await busGet(page, 'transport.beatUnit')).toBe(0);

    await pickMeter(page, '7/8');
    expect(await busGet(page, 'transport.beats')).toBe(7);
    expect(await busGet(page, 'transport.beatUnit')).toBe(1);

    // 7/8 is 14 sixteenths: the grid draws 14 columns, the ruler 14 ticks, and
    // the two cannot disagree because both resolve through `laneGrid`.
    await page.getByTestId('tab-drums').click();
    expect(await liveCells(page, 'drum-step-0-')).toBe(14);
    // Counted inside the ruler container: the `ruler-drum-bar` readout beside
    // it shares the id prefix and is not a tick.
    expect(await page.locator('[data-testid="ruler-drum"] button:visible').count()).toBe(14);
    // In meter the hint stays out of the way — the machine header has a one-row
    // budget (responsive-machine-header.md) — and the reading lives in the
    // cluster's tooltip instead.
    await expect(page.getByTestId('machine-drum-meter-hint')).toBeHidden();
    await expect(page.getByTestId('machine-drum-grid'))
      .toHaveAttribute('title', '14 steps of 1/16 = one 7/8 bar');

    // The other machines followed the same meter without being told separately.
    // Asserted as "13 is the last live cell", not by counting the prefix: the
    // Step Input arm button is `seq-step-input` and would be counted too.
    await page.getByTestId('tab-seq').click();
    await expect(page.getByTestId('seq-step-13')).toBeVisible();
    await expect(page.getByTestId('seq-step-14')).toBeHidden();
  });

  test('the steps past the length are kept, not destroyed (REQ-11)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    // Kick step 15 is off by default; switch it on, shorten the lane past it,
    // then lengthen again — the step has to come back exactly as it was.
    await page.getByTestId('drum-step-0-15').click();
    await pickMeter(page, '3/4');
    expect(await liveCells(page, 'drum-step-0-')).toBe(12);
    await pickMeter(page, '4/4');
    expect(await liveCells(page, 'drum-step-0-')).toBe(16);
    await expect(page.getByTestId('drum-step-0-15')).toHaveClass(/on/);
  });

  test('a lane can be set against the bar on purpose (REQ-10)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    await busSet(page, 'drum.len', 12);
    expect(await liveCells(page, 'drum-step-0-')).toBe(12);
    // Off the bar the hint appears and says it is deliberate, so 12-against-16
    // does not read as a bug.
    await expect(page.getByTestId('machine-drum-meter-hint'))
      .toHaveText('12 steps vs 4/4 — polyrhythm');
    // …and the sampler beside it is untouched: the override is per lane.
    await page.getByTestId('tab-sampler').click();
    expect(await liveCells(page, 'sampler-step-0-')).toBe(16);
  });

  test('the transport readout counts steps within the song bar, not a fixed 16', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    const seek = (n: number): Promise<unknown> => page.evaluate((step) => (window as unknown as {
      __synth: { engine: { seekTo(s: number): boolean } };
    }).__synth.engine.seekTo(step), n);

    // Tick 13 in 4/4 is step 14 of bar 1. (The BAR stays 1: nothing is chained,
    // so the song is one repeating bar — transport-position.md REQ-15.)
    await seek(13);
    await expect(page.getByTestId('transport-readout')).toHaveText('1.14');

    // The same tick in 3/4 is step 2 of the second bar — which is the whole
    // point: the readout counts the song's bar, not a hard-coded 16.
    await pickMeter(page, '3/4');
    await seek(13);
    await expect(page.getByTestId('transport-readout')).toHaveText('1.02');
  });
});
