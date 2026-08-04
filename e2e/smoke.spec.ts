import { test, expect } from '@playwright/test';

/**
 * Boot smoke test — the one thing unit tests can't cover: that the real app
 * boots in a browser, unlocks its AudioContext behind the "Tap to start"
 * gesture (Playwright clicks are trusted gestures, so `engine.resume()` runs),
 * loads the two AudioWorklets, and mounts a working UI.
 *
 * Selectors are text/role-based only — CSS Modules hash every class name, so
 * the only stable handles are button labels, roles, and the literal global
 * state classes `.on` (play) and `.active` (tab).
 */
test('boots, unlocks audio, and wires up the UI', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const dialogs: string[] = [];

  // Wire capture BEFORE navigating so nothing slips through during boot.
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('dialog', (d) => {
    // main.ts shows alert(...) only if boot throws — record and dismiss so a
    // boot failure fails the test instead of hanging on a modal dialog.
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Defensively ignore resource-load noise (404s etc.); we assert on app code.
    if (/Failed to load resource/i.test(msg.text())) return;
    consoleErrors.push(msg.text());
  });

  await page.goto('/');

  // Start modal is up.
  const startBtn = page.getByRole('button', { name: 'Tap to start' });
  await expect(startBtn).toBeVisible();

  // Trusted click → unlocks audio, modal fades out (gets `.hidden`, then removed).
  await startBtn.click();
  await expect(startBtn).toBeHidden();

  // Header mounted. The start modal renders the same brand block (brand.md), so
  // this is unambiguous only because the backdrop is removed before `toBeHidden`
  // above resolves — `exact` no longer does that disambiguating on its own.
  await expect(page.getByText('G1-J8', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Panic' })).toBeVisible();

  // Transport toggles label + the global `.on` state class, then back.
  // `exact` (case-sensitive) distinguishes the header "Play" from the
  // Arpeggiator's lowercase "play" segmented option (ARP_PATTERN_LABELS).
  // A virgin boot has nothing to play, so the first click opens the
  // empty-play hint (empty-play-hint.md) — opt out like a knowing user,
  // then the transport toggles bare.
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await play.click();
  await expect(page.getByTestId('empty-play-modal')).toBeVisible();
  await page.getByTestId('empty-play-dismiss').check();
  await page.getByTestId('empty-play-close').click();
  await expect(page.getByTestId('empty-play-modal')).toHaveCount(0);
  await play.click();
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop).toBeVisible();
  await expect(stop).toHaveClass(/\bon\b/);
  await stop.click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  // Pattern tabs activate on click (literal `.active` class). Selected by
  // testid, not label: the four machine tabs carry a status LED whose state is
  // mirrored into aria-label ("Sequencer — on"), so their accessible name is no
  // longer the bare label (machine-status.md REQ-4).
  for (const id of ['seq', 'drums', 'sampler', 'song', 'arp']) {
    const tab = page.locator(`[data-testid="tab-${id}"]`);
    await tab.click();
    await expect(tab).toHaveClass(/\bactive\b/);
  }

  // No uncaught exceptions, no boot-failure alert, no app-level console errors.
  expect(pageErrors).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
