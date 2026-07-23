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

/**
 * Click inside an extra track's level pad at a normalized value (y-up). Uses
 * `locator.click` rather than raw `page.mouse` so Playwright scrolls the cell
 * into view first — the panel is tall enough that a lower lane can sit below
 * the fold, and raw mouse coordinates would land somewhere else entirely.
 */
async function setTrackLevel(page: Page, track: number, step: number, v: number): Promise<void> {
  const pad = page.getByTestId(`motion-trk-${track}-step-${step}`);
  const box = await pad.boundingBox();
  if (!box) throw new Error(`motion-trk-${track}-step-${step} has no box`);
  const py = Math.min(Math.max((1 - v) * box.height, 2), box.height - 2);
  await pad.click({ position: { x: box.width / 2, y: py } });
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

test('the playhead lights the A/B track cells while playing (v6)', async ({ page }) => {
  await gotoAndStart(page);
  await openMotionTab(page);

  // Motion must be on for its onStep (the playhead) to fire.
  await page.getByTestId('switch-motion.on').click();
  await page.getByTestId('transport-play').click();

  // The playing column lights on track A's cells, not only the XY pads (REQ-16).
  // `.playing` is a global (unhashed) state class, so it selects directly.
  await expect(page.locator('[data-testid^="motion-trk-0-step-"].playing'))
    .toHaveCount(1, { timeout: 5_000 });

  await page.getByTestId('transport-play').click();
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

  // The stored file is the current version and carries the motion fields.
  const stored = await page.evaluate(() => localStorage.getItem('websynth.song.e2e-motion'));
  const parsed = JSON.parse(stored!) as { version: number; motionBanks: unknown[] };
  expect(parsed.version).toBe(6);
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
  for (const s of [0, 4, 8, 12]) await setTrackLevel(page, 0, s, 1);
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
  await setTrackLevel(page, 1, 3, 1);

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

/**
 * Panel layout — specs/features/motion-sequencer.md REQ-8/REQ-16: each lane's
 * controls sit above its own cells, and Slide/Step is per lane.
 */
test('each lane carries its own controls above its cells', async ({ page }) => {
  await gotoAndStart(page);
  await openMotionTab(page);

  // The XY lane's launcher, view toggle and mode all precede its first pad.
  const order = await page.evaluate(() => {
    const at = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;
    const pad = at('motion-step-0');
    const before = (id: string) =>
      !!(at(id).compareDocumentPosition(pad) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      xypad: before('motion-xypad'),
      view: before('motion-view'),
      slide: before('seg-motion.slide'),
      assignX: before('motion-assign-x'),
    };
  });
  expect(order).toEqual({ xypad: true, view: true, slide: true, assignX: true });

  // Each track's picker and its own Slide/Step precede that track's first cell.
  for (const t of [0, 1]) {
    const ok = await page.evaluate((track) => {
      const at = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;
      const cell = at(`motion-trk-${track}-step-0`);
      const before = (id: string) =>
        !!(at(id).compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING);
      return before(`motion-trk-${track}-param`) && before(`seg-motion.t${track}.slide`);
    }, t);
    expect(ok, `track ${t}`).toBe(true);
  }
});

test('a track’s Slide/Step is independent of the XY lane and the other track', async ({ page }) => {
  await gotoAndStart(page);
  await openMotionTab(page);

  const mode = (id: string) => page.evaluate((p) => (window as any).__synth.bus.get(p), id);
  expect(await mode('motion.slide')).toBe(1);
  expect(await mode('motion.t0.slide')).toBe(1);

  // STEP is index 0 of the segmented.
  await page.getByTestId('seg-motion.t0.slide-0').click();
  expect(await mode('motion.t0.slide')).toBe(0);
  // The XY lane and track B are untouched.
  expect(await mode('motion.slide')).toBe(1);
  expect(await mode('motion.t1.slide')).toBe(1);
});

test('Motion’s Clear menu lists every lane that holds steps', async ({ page }) => {
  await gotoAndStart(page);
  await openMotionTab(page);

  // Nothing anchored yet: only the bank item is offered.
  await page.getByTestId('clear-motion').click();
  await expect(page.getByTestId('clear-motion-bank')).toBeVisible();
  await expect(page.getByTestId('clear-motion-row-0')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Anchor the XY lane and track B (leaving A empty).
  await setAnchor(page, 2, 0.5, 0.8);
  const picker = page.getByTestId('motion-trk-1-param');
  await picker.click();
  await picker.getByText('fx.reverb.mix', { exact: true }).click();
  await setTrackLevel(page, 1, 4, 1);

  await page.getByTestId('clear-motion').click();
  await expect(page.getByTestId('clear-motion-row-0')).toContainText('XY');
  await expect(page.getByTestId('clear-motion-row-1')).toContainText('B');
  await expect(page.getByTestId('clear-motion-row-2')).toHaveCount(0); // A is empty

  // Clearing B alone leaves the XY anchors in place.
  await page.getByTestId('clear-motion-row-1').click();
  const trackOn = await page.evaluate(() =>
    (window as any).__synth.patterns.motionTrack(1).steps[4].on);
  const xyOn = await page.evaluate(() => (window as any).__synth.patterns.motion[2].on);
  expect(trackOn).toBe(false);
  expect(xyOn).toBe(true);

  // Reopened, the emptied lane is gone from the menu.
  await page.getByTestId('clear-motion').click();
  await expect(page.getByTestId('clear-motion-row-0')).toContainText('XY');
  await expect(page.getByTestId('clear-motion-row-1')).toHaveCount(0);
});
