import { test, expect } from '@playwright/test';
import { sessionDisplay, renderedDemoNames } from './helpers';

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
  // Which demo the tour uses is a production constant over data (help-content's
  // DEMO_FOR_TOUR), so derive it: a song really landed, it was one of the demos,
  // and the dropdown names it. `not.toBe('basic')` is the load-bearing half —
  // the dropdown is seeded with Song.list()[0], already a demo name, so without
  // it this would pass even if the tour step did nothing.
  const loaded = await sessionDisplay(page);
  expect(loaded).not.toBe('basic');
  expect(await renderedDemoNames(page)).toContain(loaded);
  await expect(page.getByTestId('song-slot-select').locator('button').first()).toContainText(loaded);

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

test('the ⓘ button toggles the badges and ? replays the tour', async ({ page }) => {
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

  // Idle, the ⓘ glyph is an outline ring — a matched pair with the ? beside it.
  const disc = page.locator('[data-testid="info-badges"] svg.hdr-icon .disc');
  const tittle = page.locator('[data-testid="info-badges"] svg.hdr-icon .dot');
  await expect(disc).toHaveCSS('fill', 'none');

  // One click on ⓘ switches the badges on (onboarding.md REQ-8).
  await page.getByTestId('info-badges').click();

  // The ⓘ button now reads as active (orange) while the badges show.
  await expect(page.getByTestId('info-badges')).toHaveClass(/toggleActive/);
  await expect(page.getByTestId('info-badges')).toHaveAttribute('aria-pressed', 'true');

  // …and the glyph itself becomes a badge — the accent disc and --bg-deep ink
  // the floating badges use — so the control that hides them wears one (REQ-8b).
  await expect(disc).toHaveCSS('fill', 'rgb(232, 116, 46)'); // --accent
  await expect(tittle).toHaveCSS('fill', 'rgb(5, 3, 2)'); // --bg-deep

  // A section badge anchored via `data-help` opens its contextual modal.
  const subuni = page.getByTestId('info-badge-subuni');
  await expect(subuni).toBeVisible();
  await subuni.click();
  const subuniDialog = page.getByRole('dialog', { name: 'Sub & Unison' });
  await expect(subuniDialog).toBeVisible();
  await subuniDialog.getByRole('button', { name: 'Close' }).click();

  // The header preset selector carries its own badge (onboarding.md REQ-12); its
  // copy has to separate a preset (one sound) from a song (the arrangement).
  const presetBadge = page.getByTestId('info-badge-presets');
  await expect(presetBadge).toBeVisible();

  // It hangs off the selector, not off Save — there it sat beside the ⓘ toggle
  // and outshouted the very control it should have been leading the eye to (v18).
  const badgeBox = (await presetBadge.boundingBox())!;
  const selectBox = (await page.getByTestId('preset-select').boundingBox())!;
  const saveBox = (await page.getByTestId('preset-save').boundingBox())!;
  const badgeMid = badgeBox.x + badgeBox.width / 2;
  expect(badgeMid).toBeGreaterThan(selectBox.x);
  expect(badgeMid).toBeLessThan(selectBox.x + selectBox.width);
  expect(badgeMid).toBeLessThan(saveBox.x);

  await presetBadge.click();
  const presetDialog = page.getByRole('dialog', { name: 'Presets' });
  await expect(presetDialog).toContainText('one sound');
  await expect(presetDialog).toContainText('Export bank');
  await presetDialog.getByRole('button', { name: 'Close' }).click();

  // A per-machine badge anchored to a tab button opens its own modal.
  const arpBadge = page.getByTestId('info-badge-arp');
  await expect(arpBadge).toBeVisible();
  await arpBadge.click();
  const arpDialog = page.getByRole('dialog', { name: 'Arpeggiator' });
  await expect(arpDialog).toBeVisible();
  await arpDialog.getByRole('button', { name: 'Close' }).click();

  // Collapsing/expanding a panel repositions the badges via a ResizeObserver
  // (no scroll/resize fires). A per-effect badge shows while FX is expanded,
  // hides when it collapses, and returns when it reopens.
  const distBadge = page.getByTestId('info-badge-fx.dist');
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
  const renderBadge = page.getByTestId('info-badge-seq.render');
  await expect(renderBadge).toBeVisible();
  await renderBadge.click();
  const renderDialog = page.getByRole('dialog', { name: 'Import into sampler' });
  await expect(renderDialog).toContainText('twice');
  await renderDialog.getByRole('button', { name: 'Close' }).click();

  // The playhead ruler carries a badge on every machine tab (onboarding.md
  // REQ-16) — one topic id per lane, because a hidden tab's anchor measures 0×0
  // and takes its badge with it. Check two tabs so the per-lane wiring is real.
  await page.getByTestId('ruler-seq').scrollIntoViewIfNeeded();
  const seqRulerBadge = page.getByTestId('info-badge-transport.ruler.seq');
  await expect(seqRulerBadge).toBeVisible();
  await seqRulerBadge.click();
  const rulerDialog = page.getByRole('dialog', { name: 'Playhead ruler' });
  await expect(rulerDialog).toContainText('Home');
  await rulerDialog.getByRole('button', { name: 'Close' }).click();

  await page.getByTestId('tab-drums').click();
  await page.getByTestId('ruler-drum').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('info-badge-transport.ruler.drum')).toBeVisible();
  await expect(page.getByTestId('info-badge-transport.ruler.seq')).toBeHidden();

  // The Song tab's transport row, badged on its launcher (transport-window REQ-10).
  await page.getByTestId('tab-song').click();
  await page.getByTestId('transport-open').scrollIntoViewIfNeeded();
  const transportBadge = page.getByTestId('info-badge-transport.song');
  await expect(transportBadge).toBeVisible();
  await transportBadge.click();
  const transportDialog = page.getByRole('dialog', { name: 'Transport & song position' });
  await expect(transportDialog).toContainText('bar.step');
  await transportDialog.getByRole('button', { name: 'Close' }).click();

  // The Live FX row directly below it, badged the same way — its launcher is
  // its section title too (live-fx-window REQ-7). The two read as a pair.
  await page.getByTestId('livefx-open').scrollIntoViewIfNeeded();
  const fxBadge = page.getByTestId('info-badge-song.fx');
  await expect(fxBadge).toBeVisible();
  await fxBadge.click();
  const fxDialog = page.getByRole('dialog', { name: 'Live FX' });
  await expect(fxDialog).toContainText('Tape Stop');
  await fxDialog.getByRole('button', { name: 'Close' }).click();

  // The Song panel's file buttons each carry their own badge; the Save and
  // Export copy must distinguish the two (the whole reason they exist). Open
  // the Song tab and scroll the I/O row into view so the fixed-position badges
  // land on-screen (the scroll re-runs the badge layout), then check both modals.
  await page.getByTestId('tab-song').click();
  await page.getByTestId('song-save').scrollIntoViewIfNeeded();
  const saveBadge = page.getByTestId('info-badge-song.save');
  await expect(saveBadge).toBeVisible();
  await saveBadge.click();
  const saveDialog = page.getByRole('dialog', { name: 'Save' });
  await expect(saveDialog).toContainText('Export'); // Save copy cross-references Export
  await saveDialog.getByRole('button', { name: 'Close' }).click();

  await page.getByTestId('song-export').scrollIntoViewIfNeeded();
  const exportBadge = page.getByTestId('info-badge-song.export');
  await expect(exportBadge).toBeVisible();
  await exportBadge.click();
  const exportDialog = page.getByRole('dialog', { name: 'Export' });
  await expect(exportDialog).toContainText('Save'); // Export copy cross-references Save
  await exportDialog.getByRole('button', { name: 'Close' }).click();

  // The same click switches them back off — one gesture, one outcome (REQ-8).
  await page.getByTestId('info-badges').click();
  await expect(arpBadge).toBeHidden();
  await expect(page.getByTestId('info-badges')).not.toHaveClass(/toggleActive/);

  // Replay the tour on demand — that lives behind ?, the other header door.
  await page.getByTestId('about-button').click();
  await page.getByTestId('start-tour').click();
  await expect(page.getByTestId('tour-callout')).toBeVisible();
});

test('the ⓘ button is a pure toggle and the ? button never touches the badges', async ({ page }) => {
  // onboarding.md REQ-8/REQ-19: the v13 modifier-click and long-press existed to
  // skip a chooser modal that no longer exists, so a plain click is the whole
  // inventory — and the modifier click must be no more than a plain click.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1'); // no auto-tour overlay
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await startBtn(page).click();

  const info = page.getByTestId('info-badges');
  await info.click();
  await expect(page.getByTestId('info-badge-layer')).toBeVisible();
  await expect(page.getByTestId('info-badge-arp')).toBeVisible();
  await expect(info).toHaveClass(/toggleActive/);

  await info.click();
  await expect(page.getByTestId('info-badge-layer')).toHaveCount(0);
  await expect(info).not.toHaveClass(/toggleActive/);

  // A modifier click is now just a click — one toggle, nothing extra.
  await info.click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('info-badge-layer')).toBeVisible();
  await info.click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('info-badge-layer')).toHaveCount(0);

  // The `?` key is the keyboard route to the same toggle (input-control.md REQ-9).
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByTestId('info-badge-layer')).toBeVisible();
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByTestId('info-badge-layer')).toHaveCount(0);

  // ? opens About and leaves the badges alone — the two doors never overlap.
  await page.getByTestId('about-button').click();
  await expect(page.getByTestId('start-tour')).toBeVisible();
  await expect(page.getByTestId('info-badge-layer')).toHaveCount(0);
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
  await page.getByTestId('about-button').click();
  await page.getByTestId('start-tour').click();

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

test('contextual badges hide when their control scrolls off either edge', async ({ page }) => {
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

  await page.getByTestId('info-badges').click();

  const oscBadge = page.getByTestId('info-badge-oscillators'); // content (OSC 1 panel)
  const voicingBadge = page.getByTestId('info-badge-voicing'); // header control
  const keysBadge = page.getByTestId('info-badge-keyboard');   // content, page bottom
  await expect(oscBadge).toBeVisible();
  await expect(voicingBadge).toBeVisible();
  // The other half of the rule (onboarding.md REQ-5b): the keyboard is below the
  // fold at this height, so its badge is hidden rather than pinned off-screen.
  await expect(keysBadge).toBeHidden();

  // body is the scroll container here (html,body { height:100%; overflow-y:auto }),
  // so scroll every candidate to be robust about which one actually scrolls.
  const scrollTo = (y: number): Promise<void> => page.evaluate((top) => {
    for (const el of [document.scrollingElement, document.documentElement, document.body]) {
      if (el) (el as HTMLElement).scrollTop = top;
    }
  }, y);

  // Everything up: OSC 1 goes under the header, the keyboard comes into view.
  await scrollTo(1e6);
  await expect(oscBadge).toBeHidden();       // content badge hides under the header
  await expect(voicingBadge).toBeVisible();  // header-control badge stays
  await expect(keysBadge).toBeVisible();     // and the one below the fold returns

  // The invariant behind it, swept over every badge at both extremes: a shown
  // badge is a reachable one. Only the bottom edge is swept — every badge lives
  // in the layer rather than beside its anchor, so the header-side exemption
  // can't be evaluated from the DOM here; the two assertions above cover it.
  for (const y of [0, 1e6]) {
    await scrollTo(y);
    const strays = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid^="info-badge-"]')]
        .filter((b) => b.dataset.testid !== 'info-badge-layer' && b.style.display !== 'none')
        .filter((b) => b.getBoundingClientRect().bottom > window.innerHeight)
        .map((b) => `${b.dataset.testid} @ ${Math.round(b.getBoundingClientRect().top)}`));
    expect(strays, `badges past the fold at scrollTop ${y}`).toEqual([]);
  }
});
