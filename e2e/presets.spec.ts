import { test, expect } from '@playwright/test';
import { gotoAndStart, busGet } from './helpers';

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
    page.once('dialog', (d) => d.accept('e2e-preset')); // prompt('Preset name:')
    await page.getByTestId('preset-save').click();

    const stored = await page.evaluate(() => localStorage.getItem('websynth.preset.e2e-preset'));
    expect(stored).not.toBeNull();
    await expect(page.getByTestId('preset-select')).toContainText('e2e-preset');
  });
});
