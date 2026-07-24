import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * specs/features/debug-panel.md v3 — the actions, against a real AudioContext.
 * The unit suite covers the wiring; this proves the panel works in the browser
 * it exists for (a device with no console).
 */

async function openDebug(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('about-button').click();
  const section = page.getByTestId('debug-section');
  // Default-collapsed: the header above it is the click target.
  await section.evaluate((el) => (el.previousElementSibling as HTMLElement).click());
  await expect(section).not.toHaveClass(/collapsed/);
}

test('the Debug panel reports live state and acts on it', async ({ page }) => {
  await gotoAndStart(page);
  await openDebug(page);

  // Live rows, against the real context started by "Tap to start".
  await expect(page.getByTestId('debug-ctx-state')).toHaveText('running');
  await expect(page.getByTestId('debug-transport')).toContainText('stopped');
  await expect(page.getByTestId('debug-storage')).toContainText('keys');

  // Suspend/resume round trip drives the real AudioContext.
  const toggle = page.getByTestId('debug-ctx-toggle');
  await expect(toggle).toHaveText('Suspend');
  await toggle.click();
  await expect(page.getByTestId('debug-ctx-state')).toHaveText('suspended');
  await expect(toggle).toHaveText('Resume');
  await toggle.click();
  await expect(page.getByTestId('debug-ctx-state')).toHaveText('running');

  // Panic and the test tone must not throw in a real graph.
  await page.getByTestId('debug-panic').click();
  await page.getByTestId('debug-test-tone').click();
  await expect(page.getByTestId('debug-test-tone')).toHaveText('Playing…');
});

test('Copy report puts the whole readout on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoAndStart(page);
  await openDebug(page);

  await page.getByTestId('debug-copy').click();
  await expect(page.getByTestId('debug-copy')).toHaveText('Copied!');

  const report = await page.evaluate(() => navigator.clipboard.readText());
  expect(report).toContain('AudioContext: running');
  expect(report).toContain('Perf tier:');
  expect(report).toContain('Sample rate:');
});

test('a destructive action asks first', async ({ page }) => {
  await gotoAndStart(page);
  await openDebug(page);

  await page.getByTestId('debug-session-clear').click();
  await expect(page.getByTestId('dialog-confirm')).toBeVisible();
  await page.getByTestId('dialog-cancel').click();
  // Cancelled: the panel is still there, nothing reloaded.
  await expect(page.getByTestId('debug-section')).toBeVisible();
});
