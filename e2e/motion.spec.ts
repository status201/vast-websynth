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
  expect(parsed.version).toBe(5);
  expect(parsed.motionBanks).toHaveLength(4);
});

test('the Song panel Motion card has chain controls + Mute (no solo/volume)', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('tab-song').click();
  const card = page.getByTestId('song-lane-motion');
  await expect(card).toBeVisible();
  // Chain controls + the Mute switch; no solo/volume (motion is not an audio
  // lane — motion-sequencer.md REQ-6/REQ-12).
  await expect(page.getByTestId('chain-add-motion-0')).toBeVisible();
  await expect(page.getByTestId('switch-motion.mute')).toBeVisible();
  await expect(card.getByTestId('switch-motion.solo')).toHaveCount(0);
  await expect(card.getByTestId('knob-motion.master')).toHaveCount(0);
  await page.getByTestId('chain-add-motion-1').click();
  await expect(page.getByTestId('chain-chip-motion-1')).toBeVisible();
  // The cards' rows are subgrid tracks, so the Motion card's controls align
  // vertically with the other lanes despite its knob-less mixer strip.
  const seqBox = await page.getByTestId('chain-add-seq-0').boundingBox();
  const motionBox = await page.getByTestId('chain-add-motion-0').boundingBox();
  expect(Math.abs(motionBox!.y - seqBox!.y)).toBeLessThan(2);
  // Muting dims the card like the audio lanes and restores the driven params.
  await page.getByTestId('switch-motion.mute').click();
  await expect(page.getByTestId('switch-motion.mute')).toHaveClass(/\bon\b/);
  await page.getByTestId('switch-motion.mute').click();
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

/**
 * The two extra single-param tracks — specs/features/motion-sequencer.md
 * REQ-13/REQ-16. The curve maths is unit-tested; this pins the panel wiring and
 * that a track really drives its param through the live engine.
 */
test('an extra motion track drives its own param and restores on stop', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('tab-motion').click();

  // A track with no param chosen is inert — the parameter IS the on/off.
  const cell = page.getByTestId('motion-trk-0-step-0');
  await expect(cell).toBeVisible();

  const picker = page.getByTestId('motion-trk-0-param');
  await picker.click();
  await picker.getByText('fx.delay.mix', { exact: true }).click();

  const baseline = await page.evaluate(() => (window as any).__synth.bus.get('fx.delay.mix'));

  // Anchor every step high, so any playhead position drives the same value.
  for (const s of [0, 4, 8, 12]) {
    const box = (await page.getByTestId(`motion-trk-0-step-${s}`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 2); // top of the cell = 1
    await page.mouse.down();
    await page.mouse.up();
  }
  await page.evaluate(() => (window as any).__synth.bus.set('motion.on', 1));

  await page.getByTestId('transport-play').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__synth.bus.get('fx.delay.mix')))
    .toBeGreaterThan(baseline);

  await page.getByTestId('transport-play').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__synth.bus.get('fx.delay.mix')))
    .toBeCloseTo(baseline, 4);
});

test('extra motion tracks survive a save → new → load round-trip', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('tab-motion').click();
  const picker = page.getByTestId('motion-trk-1-param');
  await picker.click();
  await picker.getByText('fx.reverb.mix', { exact: true }).click();
  const box = (await page.getByTestId('motion-trk-1-step-3').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 3);
  await page.mouse.down();
  await page.mouse.up();

  const read = () => page.evaluate(() =>
    (window as any).__synth.patterns.motionTrack(1));
  const before = await read();
  expect(before.param).toBe('fx.reverb.mix');
  expect(before.steps[3].on).toBe(true);

  await page.getByTestId('tab-song').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('song-save').click();
  await page.getByTestId('dialog-input').fill('e2e-tracks');
  await page.getByTestId('dialog-confirm').click();
  await download;
  await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

  await page.getByTestId('song-new').click();
  await page.getByTestId('dialog-confirm').click();
  expect((await read()).param).toBeUndefined();

  await page.getByTestId('song-load').click();

  const after = await read();
  expect(after.param).toBe('fx.reverb.mix');
  expect(after.steps[3].on).toBe(true);
  expect(after.steps[3].v).toBeCloseTo(before.steps[3].v, 4);
});
