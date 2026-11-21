import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * signal-flow-map.md: the map opens from the About card on the overview, zooms
 * to a picked area, and Escape steps out a level before it closes the dialog.
 * (The shipped CSP is not checked here: `vite dev` relaxes it — see the spec.)
 */
test('the signal-flow map opens, zooms to an area, and steps out on Escape', async ({ page }) => {
  await gotoAndStart(page);

  await page.getByTestId('about-button').click();
  await page.getByTestId('open-signal-flow').click();
  const stage = page.getByTestId('signal-flow-map');
  await expect(stage.getByRole('img', { name: /signal flow/ })).toBeVisible();
  await expect(page.getByTestId('signal-flow-title')).toHaveText('Overview');

  // An outlined area on the poster, then a part of it from the panel.
  await page.locator('[data-testid="signal-flow-zone"][data-zone="machines"] rect').click();
  await expect(page.getByTestId('signal-flow-title')).toHaveText('Machines & sound sources');
  await page.locator('[data-testid="signal-flow-zone"][data-zone="synth"] rect').click();
  await page.locator('[data-testid="signal-flow-area"][data-zone="voice"]').click();
  await expect(page.getByTestId('signal-flow-title')).toHaveText('Synth voice');

  // Escape climbs voice → synth → machines → overview, and only then closes.
  for (const title of ['Synth', 'Machines & sound sources', 'Overview']) {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('signal-flow-title')).toHaveText(title);
  }
  await page.keyboard.press('Escape');
  await expect(stage).toHaveCount(0);
});

test('a help topic shows its place in the signal flow', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('info-badges').click();
  await page.getByTestId('info-badge-filter').click();
  await expect(page.getByRole('dialog', { name: 'Filter' })).toBeVisible();
  await page.getByTestId('help-signal-flow').click();

  await expect(page.getByTestId('signal-flow-title')).toHaveText('Synth voice');
  await expect(page.locator('[data-testid="signal-flow-ring"][data-spot="filter"]')).toHaveCount(1);
  await expect(page.getByTestId('signal-flow-ringed')).toHaveText('Ringed: FILTER');
  // The help topic closed on the way: Escape now walks the map, not the topic.
  await expect(page.getByRole('dialog', { name: 'Filter' })).toHaveCount(0);
});

test('a topic off the signal path offers no link', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('info-badges').click();
  await page.getByTestId('info-badge-panic').click();
  await expect(page.getByRole('dialog', { name: 'Panic' })).toBeVisible();
  await expect(page.getByTestId('help-signal-flow')).toHaveCount(0);
});

test('the ✕ closes the map from a zoomed area', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('about-button').click();
  await page.getByTestId('open-signal-flow').click();
  await page.getByTestId('signal-flow-next').click();
  await expect(page.getByTestId('signal-flow-title')).not.toHaveText('Overview');
  await page.getByTestId('signal-flow-close').click();
  await expect(page.getByTestId('signal-flow-map')).toHaveCount(0);
});
