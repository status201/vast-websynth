import { test, expect } from '@playwright/test';
import { gotoAndStart, busGet, busSet, sessionDisplay } from './helpers';

/**
 * Preset dropdown applies a snapshot to the ParamBus, and Save persists a new
 * preset to localStorage + the dropdown. Boot applies the "basic" factory
 * preset (env.amp.attack = 0.005); "pad" is dramatically different (1.5).
 */
test.describe('presets', () => {
  test('selecting a preset applies its parameters', async ({ page }) => {
    await gotoAndStart(page);
    expect(await busGet(page, 'env.amp.attack')).toBeCloseTo(0.005, 3);

    const select = page.getByTestId('preset-select');
    await select.click(); // open the popover
    await select.getByText('pad', { exact: true }).click();

    await expect.poll(() => busGet(page, 'env.amp.attack')).toBeGreaterThan(1);
  });

  test('saving a preset persists to localStorage and the dropdown', async ({ page }) => {
    await gotoAndStart(page);
    // Save names the preset via the custom prompt dialog (no native prompt).
    await page.getByTestId('preset-save').click();
    await page.getByTestId('dialog-input').fill('e2e-preset');
    await page.getByTestId('dialog-confirm').click();

    const stored = await page.evaluate(() => localStorage.getItem('websynth.preset.e2e-preset'));
    expect(stored).not.toBeNull();
    await expect(page.getByTestId('preset-select')).toContainText('e2e-preset');
  });

  test('selector reflects edits (dirty marker) and resets on selection', async ({ page }) => {
    await gotoAndStart(page);
    const select = page.getByTestId('preset-select');
    // The dev bridge exposes the session; assert its exact display string
    // (the dropdown toggle also renders a caret, so DOM text isn't exact).
    const display = () => sessionDisplay(page);
    expect(await display()).toBe('basic');

    // A synth-patch edit flips the selector to the dirty marker.
    await busSet(page, 'filter.cutoff', 60);
    await expect.poll(display).toBe('basic *');
    await expect(select).toContainText('basic *');

    // A song-level edit (BPM) does NOT, by itself, change the dirty state.
    await busSet(page, 'transport.bpm', 200);
    expect(await display()).toBe('basic *');

    // Selecting a preset clears the dirty marker.
    await select.click();
    await select.getByText('pad', { exact: true }).click();
    await expect.poll(display).toBe('pad');
  });
});
