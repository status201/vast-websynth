import { test, expect } from '@playwright/test';

/**
 * The onboarding tour + contextual help. A fresh Playwright context starts with
 * empty localStorage, so the first-visit auto-launch fires without any setup;
 * the replay spec seeds the done-flag to suppress it.
 *
 * Selectors use the stable testids minted by the tour/help components
 * (CSS Modules hash class names). The dev-only `window.__synth` bridge fires the
 * note that auto-advances the interactive "press a key" step.
 */

const startBtn = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Tap to start' });

test('auto-launches on first visit, drives first sound, and never nags again', async ({ page }) => {
  await page.goto('/'); // fresh context → no done-flag → tour auto-launches
  await startBtn(page).click();

  const callout = page.getByTestId('tour-callout');
  await expect(callout).toBeVisible(); // step 1 (welcome)

  // Step 1 → 2
  await page.getByTestId('tour-next').click();
  await expect(callout).toContainText('Press a key');

  // Interactive step: a note auto-advances it. Fire one via the dev bridge,
  // re-firing under toPass so a busy box (note landing before the listener, or
  // the ~2s confirmation dwell) can't flake the auto-advance.
  await expect(async () => {
    await page.evaluate(() => (window as unknown as { __synth: { bus: { noteOn(n: number): void } } }).__synth.bus.noteOn(60));
    await expect(callout).toContainText('transport', { timeout: 3000 }); // advanced to step 3
  }).toPass({ timeout: 15000 });

  // Step 3 → 4 (the headline: loads a demo AND starts the transport)
  await page.getByTestId('tour-next').click();
  await expect(callout).toContainText('Load a demo');
  await page.getByTestId('tour-next').click();

  // Transport is now playing — the core "make it sound" gap is closed.
  await expect(page.getByTestId('transport-play')).toHaveClass(/\bon\b/);

  // …and the Song slot dropdown reflects the demo that was just loaded.
  await expect(page.getByTestId('song-slot-select').locator('button').first()).toContainText('Night Rider');

  // Bail out of the rest; finishing or skipping both set the done-flag.
  await page.getByTestId('tour-skip').click();
  await expect(callout).toBeHidden();

  // Quiesce audio before navigating: stop the transport and suspend the
  // AudioContext via the dev bridge. The tour left it playing, and an active
  // AudioContext torn down mid-navigation is what intermittently aborts the
  // reload ("net::ERR_ABORTED; frame detached"). Suspending removes that race.
  await page.getByTestId('transport-play').click();
  await page.evaluate(async () => {
    await (window as unknown as { __synth: { engine: { ctx: AudioContext } } }).__synth.engine.ctx.suspend();
  });

  // The done-flag persists in localStorage, so loading the app again does NOT
  // relaunch the tour.
  await page.goto('/');
  await startBtn(page).click();
  await expect(page.getByTestId('tour-callout')).toBeHidden();
});

test('Help button replays the tour and toggles contextual badges', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await startBtn(page).click();
  await expect(page.getByTestId('tour-callout')).toBeHidden(); // no auto-launch

  // Toggle help badges on.
  await page.getByTestId('help-button').click();
  await page.getByTestId('help-toggle-badges').click();

  // The Help button now reads as active (orange) while the badges show.
  await expect(page.getByTestId('help-button')).toHaveClass(/toggleActive/);

  // A section badge anchored via `data-help` opens its contextual modal.
  const subuni = page.getByTestId('help-badge-subuni');
  await expect(subuni).toBeVisible();
  await subuni.click();
  const subuniDialog = page.getByRole('dialog', { name: 'Sub & Unison' });
  await expect(subuniDialog).toBeVisible();
  await subuniDialog.getByRole('button', { name: 'Close' }).click();

  // A per-machine badge anchored to a tab button opens its own modal.
  const arpBadge = page.getByTestId('help-badge-arp');
  await expect(arpBadge).toBeVisible();
  await arpBadge.click();
  const arpDialog = page.getByRole('dialog', { name: 'Arpeggiator' });
  await expect(arpDialog).toBeVisible();
  await arpDialog.getByRole('button', { name: 'Close' }).click();

  // Collapsing/expanding a panel repositions the badges via a ResizeObserver
  // (no scroll/resize fires). A per-effect badge shows while FX is expanded,
  // hides when it collapses, and returns when it reopens.
  const distBadge = page.getByTestId('help-badge-fx.dist');
  await expect(distBadge).toBeVisible();
  await page.getByTestId('fx').click({ position: { x: 20, y: 10 } }); // collapse FX bar
  await expect(distBadge).toBeHidden();
  await page.getByTestId('fx').click({ position: { x: 20, y: 10 } }); // expand again
  await expect(distBadge).toBeVisible();

  // Toggle badges off again → no chrome left behind. Reopening the menu shows
  // the toggle button itself active; turning it off clears the Help button.
  await page.getByTestId('help-button').click();
  await expect(page.getByTestId('help-toggle-badges')).toHaveClass(/toggleActive/);
  await page.getByTestId('help-toggle-badges').click();
  await expect(arpBadge).toBeHidden();
  await expect(page.getByTestId('help-button')).not.toHaveClass(/toggleActive/);

  // Replay the tour on demand. The closed menu lingers in the DOM for its
  // 200ms fade-out (Modal.close), so wait for it to detach before reopening —
  // otherwise two help-start-tour buttons coexist and strict mode trips.
  await expect(page.getByTestId('help-start-tour')).toHaveCount(0);
  await page.getByTestId('help-button').click();
  await page.getByTestId('help-start-tour').click();
  await expect(page.getByTestId('tour-callout')).toBeVisible();
});

test('contextual badges hide when their control scrolls under the sticky header', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
    } catch {
      /* ignore */
    }
  });
  // Short (but still desktop-width) viewport so the page scrolls; width 1440
  // keeps isCompact/isPhone false, so the layout is unchanged.
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto('/');
  await startBtn(page).click();

  await page.getByTestId('help-button').click();
  await page.getByTestId('help-toggle-badges').click();

  const oscBadge = page.getByTestId('help-badge-oscillators'); // content (OSC 1 panel)
  const voicingBadge = page.getByTestId('help-badge-voicing'); // header control
  await expect(oscBadge).toBeVisible();
  await expect(voicingBadge).toBeVisible();

  // Scroll the OSC 1 panel up under the sticky header. body is the scroll
  // container here (html,body { height:100%; overflow-y:auto }), so scroll
  // every candidate to be robust about which one actually scrolls.
  await page.evaluate(() => {
    for (const el of [document.scrollingElement, document.documentElement, document.body]) {
      if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    }
  });

  await expect(oscBadge).toBeHidden(); // content badge hides under the header
  await expect(voicingBadge).toBeVisible(); // header-control badge stays
});
