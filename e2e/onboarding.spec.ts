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

  // The header Presets button carries its own badge (onboarding.md REQ-12); its
  // copy has to separate a preset (one sound) from a song (the arrangement).
  const presetBadge = page.getByTestId('help-badge-presets');
  await expect(presetBadge).toBeVisible();
  await presetBadge.click();
  const presetDialog = page.getByRole('dialog', { name: 'Presets' });
  await expect(presetDialog).toContainText('one sound');
  await expect(presetDialog).toContainText('Export bank');
  await presetDialog.getByRole('button', { name: 'Close' }).click();

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

  // The Sequencer's Render button (onboarding.md REQ-15): its badge must say why
  // the render plays the bar twice, or the wait reads as a hang. The tab row
  // opens on Arpeggiator, so reveal the Sequencer first — the badge repositions
  // via the pattern-row ResizeObserver.
  await page.getByTestId('tab-seq').click();
  await page.getByTestId('seq-import-render').scrollIntoViewIfNeeded();
  const renderBadge = page.getByTestId('help-badge-seq.render');
  await expect(renderBadge).toBeVisible();
  await renderBadge.click();
  const renderDialog = page.getByRole('dialog', { name: 'Import into sampler' });
  await expect(renderDialog).toContainText('twice');
  await renderDialog.getByRole('button', { name: 'Close' }).click();

  // The Song panel's file buttons each carry their own badge; the Save and
  // Export copy must distinguish the two (the whole reason they exist). Open
  // the Song tab and scroll the I/O row into view so the fixed-position badges
  // land on-screen (the scroll re-runs the badge layout), then check both modals.
  await page.getByTestId('tab-song').click();
  await page.getByTestId('song-save').scrollIntoViewIfNeeded();
  const saveBadge = page.getByTestId('help-badge-song.save');
  await expect(saveBadge).toBeVisible();
  await saveBadge.click();
  const saveDialog = page.getByRole('dialog', { name: 'Save' });
  await expect(saveDialog).toContainText('Export'); // Save copy cross-references Export
  await saveDialog.getByRole('button', { name: 'Close' }).click();

  await page.getByTestId('song-export').scrollIntoViewIfNeeded();
  const exportBadge = page.getByTestId('help-badge-song.export');
  await expect(exportBadge).toBeVisible();
  await exportBadge.click();
  const exportDialog = page.getByRole('dialog', { name: 'Export' });
  await expect(exportDialog).toContainText('Save'); // Export copy cross-references Save
  await exportDialog.getByRole('button', { name: 'Close' }).click();

  // While the badges show, the active Help button is a one-click off switch:
  // clicking it disables the badges directly, without opening the menu.
  await page.getByTestId('help-button').click();
  await expect(arpBadge).toBeHidden();
  await expect(page.getByTestId('help-button')).not.toHaveClass(/toggleActive/);
  await expect(page.getByTestId('help-start-tour')).toHaveCount(0); // no modal opened

  // Replay the tour on demand — with badges off, the Help button opens the
  // chooser menu again.
  await page.getByTestId('help-button').click();
  await page.getByTestId('help-start-tour').click();
  await expect(page.getByTestId('tour-callout')).toBeVisible();
});

test('the tour showcases the Song tab and ends there, ready to play', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await startBtn(page).click();

  // Replay on demand rather than relying on the auto-launch, so this spec is
  // independent of first-visit ordering.
  await page.getByTestId('help-button').click();
  await page.getByTestId('help-start-tour').click();

  const callout = page.getByTestId('tour-callout');
  await expect(callout).toBeVisible();

  // Walk to the end. `tour-next` flips to `tour-done` on the last step, so the
  // loop terminates on its own — no hardcoded step count (the tour's progress is
  // derived from TOUR_STEPS.length).
  const done = page.getByTestId('tour-done');
  for (let i = 0; i < 30 && (await done.count()) === 0; i++) {
    await page.getByTestId('tour-next').click();
  }
  await expect(done).toBeVisible();

  // The two Song-tab steps sit just before the closing one (REQ-10).
  await page.getByTestId('tour-back').click();
  await expect(callout).toContainText('Perform it live');
  await page.getByTestId('tour-back').click();
  await expect(callout).toContainText('Arrange a full song');

  // And before those, the gesture step — on the DRUM grid, so the spotlight
  // actually moves off the sequencer the preceding step highlights (REQ-13).
  await page.getByTestId('tour-back').click();
  await expect(callout).toContainText('Paint a pattern');
  await expect(page.getByTestId('panel-drums')).toBeVisible();

  // Forward again to the end and finish.
  await page.getByTestId('tour-next').click();
  await page.getByTestId('tour-next').click();
  await page.getByTestId('tour-next').click();
  await done.click();
  await expect(callout).toBeHidden();

  // The tour leaves the user on the Song tab — chains and live FX in reach.
  await expect(page.getByTestId('panel-song')).toBeVisible();
  await expect(page.getByTestId('song-lane-seq')).toBeVisible();
  await expect(page.getByTestId('perf-stutter')).toBeVisible();
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
