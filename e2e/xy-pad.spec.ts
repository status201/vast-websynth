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

  test('the surface labels each axis with the assigned param short name', async ({ page }) => {
    await page.getByTestId('perf-xypad').click();
    await expect(page.getByTestId('xypad-axis-x')).toHaveText('cutoff');
    await expect(page.getByTestId('xypad-axis-y')).toHaveText('resonance');

    await page.evaluate(() => (window as any).__synth.xy.set({ x: 'lfo.rate' }));
    await expect(page.getByTestId('xypad-axis-x')).toHaveText('rate');
  });

  test('the title-bar gear toggles the assign dropdowns (collapsed by default)', async ({ page }) => {
    await page.getByTestId('perf-xypad').click();
    const gear = page.getByTestId('xypad-gear');
    await expect(gear).toBeVisible();

    // Collapsed on open: the X dropdown is hidden, the gear is not expanded.
    await expect(page.getByTestId('xypad-assign-x')).toBeHidden();
    await expect(gear).toHaveAttribute('aria-expanded', 'false');

    // Click reveals the dropdowns and rotates the gear.
    await gear.click();
    await expect(page.getByTestId('xypad-assign-x')).toBeVisible();
    await expect(gear).toHaveAttribute('aria-expanded', 'true');

    // Click again hides them.
    await gear.click();
    await expect(page.getByTestId('xypad-assign-x')).toBeHidden();
    await expect(gear).toHaveAttribute('aria-expanded', 'false');
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

    // Save persists it (custom prompt dialog; also downloads a JSON copy).
    const dl = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await page.getByTestId('dialog-input').fill('e2e-xy');
    await page.getByTestId('dialog-confirm').click();
    await dl; // consume the download so it doesn't dangle

    // Move X somewhere else, then Load the slot: the saved v3 assignment wins.
    await page.evaluate(() => (window as any).__synth.xy.set({ x: 'filter.cutoff' }));
    expect(await xyX(page)).toBe('filter.cutoff');

    await page.getByTestId('song-load').click();
    await expect.poll(() => xyX(page)).toBe('lfo.rate');
  });
});
