import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const seqOn = (page: import('@playwright/test').Page, i: number): Promise<boolean> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[idx].on, i);
const seqNote = (page: import('@playwright/test').Page, i: number): Promise<number> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[idx].note, i);
const playNote = (page: import('@playwright/test').Page, n: number): Promise<void> =>
  page.evaluate((note) => (window as any).__synth.bus.noteOn(note), n);
const drumOn = (page: import('@playwright/test').Page, t: number, s: number): Promise<boolean> =>
  page.evaluate((a) => (window as any).__synth.patterns.drum[a.t][a.s].on, { t, s });
const clockStep = (page: import('@playwright/test').Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.clock.step);

/**
 * Grid edits flow UI click → PatternStore (read back via the bridge), and the
 * transport actually advances the look-ahead clock.
 */
test.describe('pattern grids', () => {
  test('sequencer step click toggles PatternStore', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    const before = await seqOn(page, 5);
    await page.getByTestId('seq-step-5').click();
    expect(await seqOn(page, 5)).toBe(!before);
    await page.getByTestId('seq-step-5').click();
    expect(await seqOn(page, 5)).toBe(before);
  });

  test('step record fills steps from played notes and advances', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();

    // Arm Step Input, then "play" notes — each lands in the selected step and
    // the cursor advances on its own (starts at step 0).
    await page.getByTestId('seq-step-input').click();
    await playNote(page, 64);
    await playNote(page, 67);
    expect(await seqNote(page, 0)).toBe(64);
    expect(await seqOn(page, 0)).toBe(true);
    expect(await seqNote(page, 1)).toBe(67);

    // While armed, clicking a step only moves the cursor (no on/off toggle).
    const before = await seqOn(page, 8);
    await page.getByTestId('seq-step-8').click();
    expect(await seqOn(page, 8)).toBe(before);
    await playNote(page, 72);
    expect(await seqNote(page, 8)).toBe(72);
  });

  test('drum cell click toggles PatternStore', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    const before = await drumOn(page, 0, 0);
    await page.getByTestId('drum-step-0-0').click();
    expect(await drumOn(page, 0, 0)).toBe(!before);
  });

  test('transport advances the clock', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('transport-play').click();
    await expect.poll(() => clockStep(page), { timeout: 4000 }).toBeGreaterThan(2);
    await page.getByTestId('transport-play').click(); // stop
  });
});
