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

/**
 * pwa-install.md REQ-1 — the wake lock must be taken on the auto-start path.
 *
 * A regression guard with a specific history: the lock was driven purely off the
 * AudioContext's `statechange`, which never fires for a context the browser
 * created already `running` (audio-lifecycle.md REQ-20) — and resuming an
 * already-running one does not fire it either. So on exactly the devices that
 * skip the start modal, the screen was free to sleep mid-performance, while the
 * unit tests for `WakeLockManager` stayed green because nothing ever called it.
 * This suite runs with autoplay permitted, so it *is* that path.
 */
test('the wake lock is requested even when no statechange ever fires', async ({ page }) => {
  // Count the requests rather than asserting the lock is *held*: headless
  // Chromium exposes the API but rejects the request (there is no screen to keep
  // awake), and `WakeLockManager` swallows a rejection by design. Whether the
  // platform grants it is not ours to test; whether boot asks is exactly ours.
  await page.addInitScript(() => {
    (window as unknown as { __wakeAsks: number }).__wakeAsks = 0;
    const wl = navigator.wakeLock;
    if (!wl) return;
    const real = wl.request.bind(wl);
    wl.request = ((type: WakeLockType) => {
      (window as unknown as { __wakeAsks: number }).__wakeAsks++;
      return real(type);
    }) as typeof wl.request;
  });

  await gotoAndStart(page);

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __wakeAsks: number }).__wakeAsks))
    .toBeGreaterThan(0);
});

test('the Debug panel reports live state and acts on it', async ({ page }) => {
  await gotoAndStart(page);
  await openDebug(page);

  // Live rows, against the real context. The row appends the autoplay verdict
  // that decided whether a start modal was shown at all (audio-lifecycle.md
  // REQ-20) — and this suite runs with autoplay permitted, so it reads `ok`.
  await expect(page.getByTestId('debug-ctx-state')).toHaveText('running · autoplay ok');
  await expect(page.getByTestId('debug-transport')).toContainText('stopped');
  await expect(page.getByTestId('debug-storage')).toContainText('keys');

  // Suspend/resume round trip drives the real AudioContext.
  const toggle = page.getByTestId('debug-ctx-toggle');
  await expect(toggle).toHaveText('Suspend');
  await toggle.click();
  await expect(page.getByTestId('debug-ctx-state')).toHaveText('suspended · autoplay ok');
  await expect(toggle).toHaveText('Resume');
  // REQ-15 regression: the statechange re-arm now runs on every platform, so a
  // deliberate suspend has to survive the event its own suspend() fires. If the
  // intent flag were missing this would be back to 'running' immediately.
  await page.waitForTimeout(400);
  await expect(page.getByTestId('debug-ctx-state')).toHaveText('suspended · autoplay ok');
  await toggle.click();
  await expect(page.getByTestId('debug-ctx-state')).toHaveText('running · autoplay ok');

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
