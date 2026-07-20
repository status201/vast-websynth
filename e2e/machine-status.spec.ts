import { test, expect } from '@playwright/test';
import { gotoAndStart, busSet } from './helpers';

// machine-status.md — the Song tab's clickable lane titles and the tab bar's
// machine status LEDs.

const led = (page: import('@playwright/test').Page, tab: string) =>
  page.locator(`[data-testid="tab-${tab}"] span[data-state]`);

test.describe('machine status', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await page.locator('[data-testid="tab-song"]').click();
    await expect(page.locator('[data-testid="panel-song"]')).toBeVisible();
  });

  test('a lane title opens that machine tab (REQ-5)', async ({ page }) => {
    // The lane prefix is `drum` but the tab id is `drums` — the mapping is the
    // thing under test here.
    await page.locator('[data-testid="song-lane-title-drum"]').click();
    await expect(page.locator('[data-testid="panel-drums"]')).toBeVisible();
    await expect(page.locator('[data-testid="panel-song"]')).toBeHidden();

    // And back again from another lane title.
    await page.locator('[data-testid="tab-song"]').click();
    await page.locator('[data-testid="song-lane-title-motion"]').click();
    await expect(page.locator('[data-testid="panel-motion"]')).toBeVisible();
  });

  test('every machine lane title navigates (REQ-5)', async ({ page }) => {
    for (const [prefix, tab] of [
      ['seq', 'seq'],
      ['drum', 'drums'],
      ['sampler', 'sampler'],
      ['motion', 'motion'],
    ]) {
      await page.locator('[data-testid="tab-song"]').click();
      await page.locator(`[data-testid="song-lane-title-${prefix}"]`).click();
      await expect(page.locator(`[data-testid="panel-${tab}"]`)).toBeVisible();
    }
  });

  test('the tab LED tracks enable and mute state (REQ-2/REQ-4)', async ({ page }) => {
    await busSet(page, 'drum.on', 1);
    await busSet(page, 'drum.mute', 0);
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'on');

    // Enabled but silenced by its own mute.
    await busSet(page, 'drum.mute', 1);
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'muted');

    // Disabled wins over the mixer state.
    await busSet(page, 'drum.on', 0);
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'off');
    // State is never colour-only.
    await expect(page.locator('[data-testid="tab-drums"]')).toHaveAttribute(
      'aria-label', 'Drum Machine — off',
    );
  });

  test('another lane soloing mutes the others but not motion (REQ-2)', async ({ page }) => {
    for (const m of ['seq', 'drum', 'sampler', 'motion']) {
      await busSet(page, `${m}.on`, 1);
      await busSet(page, `${m}.mute`, 0);
    }
    await busSet(page, 'seq.solo', 1);

    await expect(led(page, 'seq')).toHaveAttribute('data-state', 'on');
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'muted');
    await expect(led(page, 'sampler')).toHaveAttribute('data-state', 'muted');
    // Motion is not an audio lane — a solo elsewhere must not silence it.
    await expect(led(page, 'motion')).toHaveAttribute('data-state', 'on');
  });

  test('the LED is inert — clicking it navigates and changes no param (REQ-3)', async ({ page }) => {
    await busSet(page, 'drum.on', 1);
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'on');

    // pointer-events:none means the click lands on the tab, not the dot.
    await led(page, 'drums').click({ force: true });
    await expect(page.locator('[data-testid="panel-drums"]')).toBeVisible();
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'on');
  });
});
