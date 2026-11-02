import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet, startAudio } from './helpers';

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

  test('the axis picker filters its ~200 param ids down to one match', async ({ page }) => {
    // dropdown.md REQ-a-long-list-carries-a-filter: the assign pickers list every bus param id, so they
    // carry a live filter. Before it, choosing a param meant scrolling ~20
    // screens — which is why the other specs here set axes via __synth.xy.
    await page.getByTestId('perf-xypad').click();
    await page.getByTestId('xypad-gear').click();

    const picker = page.getByTestId('xypad-assign-x');
    await picker.locator('button').first().click(); // the toggle
    const filter = picker.getByTestId('dropdown-filter');
    await expect(filter).toBeFocused();

    await filter.fill('delay.mix');
    // Three buses carry a delay mix; pick the synth one by exact text.
    await picker.getByText('fx.delay.mix', { exact: true }).click();
    expect(await xyX(page)).toBe('fx.delay.mix');
    await expect(page.getByTestId('xypad-axis-x')).toHaveText('mix');

    // Reopening starts from the whole list again, never a stale query.
    await picker.locator('button').first().click();
    await expect(filter).toHaveValue('');
    await expect(picker.getByText('lfo.rate', { exact: true })).toBeVisible();

    // dropdown.md REQ-arrow-keys-move-the-selection: each arrow moves one option. The bug this pins is a
    // second ArrowDown only scrolling the menu instead of advancing the cursor.
    await page.keyboard.press('ArrowDown');
    const first = await page.evaluate(() => document.activeElement?.textContent);
    await page.keyboard.press('ArrowDown');
    const second = await page.evaluate(() => document.activeElement?.textContent);
    await page.keyboard.press('ArrowDown');
    const third = await page.evaluate(() => document.activeElement?.textContent);
    expect(new Set([first, second, third]).size).toBe(3); // three distinct options

    // Enter takes the focused one, so the whole pick is keyboard-only.
    await page.keyboard.press('Enter');
    expect(await xyX(page)).toBe(third);
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

  // REQ-the-pad-is-resizable — the corner grip grows the square; the size is
  // remembered; double-click goes back to 240.
  test('the corner grip grows the pad, which stays square, mapped and remembered', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.getByTestId('perf-xypad').click();
    const surface = page.getByTestId('xypad-surface');
    const before = (await surface.boundingBox())!;
    expect(Math.round(before.width)).toBe(240);

    const grip = page.getByTestId('xypad-window-resize');
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 200, g.y + g.height / 2 + 120, { steps: 5 });
    await page.mouse.up();

    const after = (await surface.boundingBox())!;
    expect(Math.round(after.width)).toBe(440); // the larger delta (200) wins
    expect(Math.abs(after.width - after.height)).toBeLessThan(1);

    // The pointer mapping follows the bigger surface: its centre is the middle of both axes.
    await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2);
    await page.mouse.down();
    const dot = page.getByTestId('xypad-dot');
    const at = await dot.evaluate((el) => [parseFloat(el.style.left), parseFloat(el.style.top)]);
    await page.mouse.up();
    expect(Math.abs(at[0]! - 50)).toBeLessThan(1);
    expect(Math.abs(at[1]! - 50)).toBeLessThan(1);

    // Remembered across a reload.
    await page.reload();
    await startAudio(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('perf-xypad').click();
    expect(Math.round((await surface.boundingBox())!.width)).toBe(440);

    // Double-click forgets it.
    await grip.dblclick();
    await expect.poll(async () => Math.round((await surface.boundingBox())!.width)).toBe(240);
    expect(await page.evaluate(() => localStorage.getItem('websynth.ui.window.xypad.size'))).toBeNull();
  });

  test('the pad stops at 960 px, and sooner where the viewport ends', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 800 });
    await page.getByTestId('perf-xypad').click();
    const surface = page.getByTestId('xypad-surface');
    const g = (await page.getByTestId('xypad-window-resize').boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + 2000, g.y + 2000, { steps: 5 });
    await page.mouse.up();

    const s = (await surface.boundingBox())!;
    const win = (await page.getByTestId('xypad-window').boundingBox())!;
    expect(s.width).toBeLessThanOrEqual(960);
    expect(win.y + win.height).toBeLessThanOrEqual(800 + 1); // the viewport, not 960, had the last word
    expect(win.x + win.width).toBeLessThanOrEqual(1600 + 1);
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
