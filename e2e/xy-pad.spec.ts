import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet } from './helpers';

/**
 * The XY Pad — a non-modal floating controller launched from the Song tab's
 * Live FX row. It drives two assignable params from a drag and springs them back
 * on release (momentary DJ-FX semantics), and its axis assignment persists in a
 * song via SongFile v3. See specs/features/xy-pad.md.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const clockPlaying = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).__synth.engine.clock.playing as boolean);
const xyX = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).__synth.xy.get().x as string);

test.describe('XY Pad', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
  });

  test('the launch button opens a non-modal window — the transport stays live', async ({ page }) => {
    await page.getByTestId('perf-xypad').click();
    await expect(page.getByTestId('xypad-window')).toBeVisible();

    // No backdrop: the header Play button is still clickable through the open pad.
    await page.getByTestId('transport-play').click();
    expect(await clockPlaying(page)).toBe(true);
    await page.getByTestId('transport-play').click(); // stop again

    // The button toggles the window shut.
    await page.getByTestId('perf-xypad').click();
    await expect(page.getByTestId('xypad-window')).toBeHidden();
  });

  test('dragging the pad sweeps a param, which springs back on release', async ({ page }) => {
    await page.getByTestId('perf-xypad').click();
    const surface = page.getByTestId('xypad-surface');
    await expect(surface).toBeVisible();
    const box = await surface.boundingBox();
    if (!box) throw new Error('xy surface has no bounding box');

    const pre = await busGet(page, 'filter.cutoff');

    // Press near the right edge -> high cutoff. The value moves on pointerdown.
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5);
    await page.mouse.down();
    await expect.poll(() => busGet(page, 'filter.cutoff')).toBeGreaterThan(pre);

    // Releasing springs it back to exactly where it started.
    await page.mouse.up();
    await expect.poll(() => busGet(page, 'filter.cutoff')).toBeCloseTo(pre, 2);
  });

  test('the axis assignment round-trips through a saved song (v3)', async ({ page }) => {
    await page.getByTestId('perf-xypad').click();

    // Reassign X to lfo.rate (the dropdown -> store path is unit-tested).
    await page.evaluate(() => (window as any).__synth.xy.set({ x: 'lfo.rate' }));
    expect(await xyX(page)).toBe('lfo.rate');

    // Save persists it (prompts a name; also downloads a JSON copy).
    page.once('dialog', (d) => d.accept('e2e-xy'));
    const dl = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await dl; // consume the download so it doesn't dangle

    // Move X somewhere else, then Load the slot: the saved v3 assignment wins.
    await page.evaluate(() => (window as any).__synth.xy.set({ x: 'filter.cutoff' }));
    expect(await xyX(page)).toBe('filter.cutoff');

    await page.getByTestId('song-load').click();
    await expect.poll(() => xyX(page)).toBe('lfo.rate');
  });
});
