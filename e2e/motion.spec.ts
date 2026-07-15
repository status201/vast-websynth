import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet } from './helpers';

/**
 * Motion sequencer (specs/features/motion-sequencer.md): anchor input on the
 * mini XY pads, live param automation while playing (factory assignment:
 * x = filter.cutoff, y = filter.resonance — the specs drive y anchors and
 * watch filter.resonance move), baseline restore on stop, the view toggle,
 * and a save→new→load round-trip.
 */

/** Click inside a motion step pad at a normalized (x, y-up) coordinate. */
async function setAnchor(page: Page, step: number, x: number, y: number): Promise<void> {
  const pad = page.getByTestId(`motion-step-${step}`);
  const box = await pad.boundingBox();
  if (!box) throw new Error(`motion-step-${step} has no box`);
  // Keep 2px inside the edges so the click stays on the pad.
  const px = Math.min(Math.max(x * box.width, 2), box.width - 2);
  const py = Math.min(Math.max((1 - y) * box.height, 2), box.height - 2);
  await pad.click({ position: { x: px, y: py } });
}

async function openMotionTab(page: Page): Promise<void> {
  await page.getByTestId('tab-motion').click();
  await expect(page.getByTestId('motion-step-0')).toBeVisible();
}

test('anchors drive the assigned params while playing and restore on stop', async ({ page }) => {
  await gotoAndStart(page);
  await openMotionTab(page);

  // A 1-bar sweep on the y axis (factory assignment: y = filter.resonance).
  await setAnchor(page, 0, 0.5, 0);
  await setAnchor(page, 8, 0.5, 1);
  await expect(page.getByTestId('motion-step-0')).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('motion-step-8')).toHaveClass(/\bon\b/);

  // Enable the machine and play.
  await page.getByTestId('switch-motion.on').click();
  const resBefore = await busGet(page, 'filter.resonance');
  await page.getByTestId('transport-play').click();

  // The param must move, and keep moving (slide interpolation).
  await expect.poll(() => busGet(page, 'filter.resonance'), { timeout: 5_000 })
    .not.toBe(resBefore);
  const a = await busGet(page, 'filter.resonance');
  await page.waitForTimeout(400);
  const b = await busGet(page, 'filter.resonance');
  expect(b).not.toBe(a);

  // Stop → the baseline is restored (REQ-5).
  await page.getByTestId('transport-play').click();
  await expect.poll(() => busGet(page, 'filter.resonance')).toBe(resBefore);
});

test('the graph traces the selected axis and the view toggle switches it', async ({ page }) => {
  await gotoAndStart(page);
  await openMotionTab(page);

  await setAnchor(page, 0, 0.1, 0.9);
  await setAnchor(page, 4, 0.9, 0.1);
  const circles = page.getByTestId('motion-graph').locator('circle');
  await expect(circles).toHaveCount(2);
  const yFirst = Number(await circles.first().getAttribute('cy'));

  await page.getByTestId('motion-view-x').click();
  const xFirst = Number(await circles.first().getAttribute('cy'));
  // y=0.9 plots high (cy 10), x=0.1 plots low (cy 90) — the line re-drew.
  expect(Math.abs(xFirst - yFirst)).toBeGreaterThan(50);
});

test('motion state survives a save → new → load round-trip', async ({ page }) => {
  await gotoAndStart(page);
  await openMotionTab(page);
  await setAnchor(page, 3, 0.25, 0.75);
  await expect(page.getByTestId('motion-step-3')).toHaveClass(/\bon\b/);

  await page.getByTestId('tab-song').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('song-save').click();
  await page.getByTestId('dialog-input').fill('e2e-motion');
  await page.getByTestId('dialog-confirm').click();
  await download;
  await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

  await page.getByTestId('song-new').click();
  await page.getByTestId('dialog-confirm').click();
  await openMotionTab(page);
  await expect(page.getByTestId('motion-step-3')).not.toHaveClass(/\bon\b/);

  await page.getByTestId('tab-song').click();
  await page.getByTestId('song-load').click();
  await openMotionTab(page);
  await expect(page.getByTestId('motion-step-3')).toHaveClass(/\bon\b/);

  // The stored file is v4 with motion fields.
  const stored = await page.evaluate(() => localStorage.getItem('websynth.song.e2e-motion'));
  const parsed = JSON.parse(stored!) as { version: number; motionBanks: unknown[] };
  expect(parsed.version).toBe(4);
  expect(parsed.motionBanks).toHaveLength(4);
});

test('the Song panel has a chain-only Motion card', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('tab-song').click();
  const card = page.getByTestId('song-lane-motion');
  await expect(card).toBeVisible();
  // Chain controls present; no mute/solo mixer strip (motion is not an audio lane).
  await expect(page.getByTestId('chain-add-motion-0')).toBeVisible();
  await expect(card.getByText('Mute')).toHaveCount(0);
  await page.getByTestId('chain-add-motion-1').click();
  await expect(page.getByTestId('chain-chip-motion-1')).toBeVisible();
});

test('the XY Pad axes follow the motion bank override (effective assignment)', async ({ page }) => {
  await gotoAndStart(page);
  await openMotionTab(page);

  // Override this bank's x axis via the store (the dropdown UI is a 200-item
  // list; the dev bridge is the stable way to set a specific id).
  await page.evaluate(() => {
    (window as any).__synth.patterns.setMotionAssign({ x: 'fx.delay.time' });
  });
  await page.getByTestId('switch-motion.on').click();

  await page.getByTestId('motion-xypad').click();
  const xLabel = page.getByTestId('xypad-axis-x');
  const yLabel = page.getByTestId('xypad-axis-y');
  await expect(xLabel).toHaveText('time');       // fx.delay.time (override)
  await expect(yLabel).toHaveText('resonance');  // base fallback

  // Turning motion off returns the pad to the base assignment.
  await page.getByTestId('switch-motion.on').click();
  await expect(xLabel).toHaveText('cutoff');
});
