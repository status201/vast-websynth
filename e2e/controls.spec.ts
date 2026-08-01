import { test, expect } from '@playwright/test';
import { gotoAndStart, busGet, busSet, dragKnobUp } from './helpers';

/**
 * Exercises the Phase-2 test surface: the `data-testid` handles added to the
 * interactive components + the dev-only `window.__synth` bridge (engine / bus /
 * patterns) for reading state. These replace the brittle text/role selectors
 * that collided in the smoke test (e.g. the header "Play" vs the Arpeggiator's
 * lowercase "play"). The bridge is dev-only, so these specs assume the dev
 * server — Playwright's configured webServer here.
 */

test.describe('control surface (testids + debug bridge)', () => {
  test('debug bridge is exposed', async ({ page }) => {
    await gotoAndStart(page);
    const ok = await page.evaluate(
      () => typeof (window as unknown as { __synth?: { bus?: { get?: unknown } } }).__synth?.bus?.get === 'function',
    );
    expect(ok).toBe(true);
  });

  test('tabs activate by testid and reveal their panel', async ({ page }) => {
    await gotoAndStart(page);
    for (const id of ['seq', 'drums', 'sampler', 'song', 'arp']) {
      const tab = page.getByTestId(`tab-${id}`);
      await tab.click();
      await expect(tab).toHaveClass(/\bactive\b/);
      await expect(page.getByTestId(`panel-${id}`)).toBeVisible();
    }
  });

  test('transport testid toggles the clock', async ({ page }) => {
    await gotoAndStart(page);
    const play = page.getByTestId('transport-play');
    const playing = () =>
      page.evaluate(() => (window as unknown as { __synth: { engine: { clock: { playing: boolean } } } }).__synth.engine.clock.playing);
    expect(await playing()).toBe(false);
    await play.click();
    expect(await playing()).toBe(true);
    await play.click();
    expect(await playing()).toBe(false);
  });

  test('a knob responds to vertical drag', async ({ page }) => {
    await gotoAndStart(page);
    const knob = page.getByTestId('knob-filter.cutoff');
    await expect(knob).toBeVisible();
    const before = await busGet(page, 'filter.cutoff');
    const box = await knob.boundingBox();
    if (!box) throw new Error('knob has no bounding box');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 6 }); // drag up = increase
    await page.mouse.up();
    expect(await busGet(page, 'filter.cutoff')).toBeGreaterThan(before);
  });

  test('double-tapping a knob resets it to the loaded preset value, not the global default', async ({ page }) => {
    await gotoAndStart(page);
    // Load "acid" (filter.cutoff 60) so the reset baseline differs from the
    // registered default (90).
    const select = page.getByTestId('preset-select');
    await select.click();
    await select.getByText('acid', { exact: true }).click();
    await expect.poll(() => busGet(page, 'filter.cutoff')).toBeCloseTo(60, 1);

    await dragKnobUp(page, 'knob-filter.cutoff'); // move it away from 60
    expect(await busGet(page, 'filter.cutoff')).toBeGreaterThan(60);

    await page.getByTestId('knob-filter.cutoff').dblclick(); // two pointerdowns < 300 ms
    await expect.poll(() => busGet(page, 'filter.cutoff')).toBeCloseTo(60, 1);
  });

  test('the filter model switch selects POLY and enables SHAPE', async ({ page }) => {
    await gotoAndStart(page);
    expect(await busGet(page, 'filter.model')).toBe(0); // ladder by default

    const shape = page.getByTestId('knob-filter.shape');
    // SHAPE belongs to POLY, so it is dimmed until the model is switched.
    await expect(shape).toHaveAttribute('aria-disabled', 'true');

    await page.getByTestId('seg-filter.model-1').click();
    expect(await busGet(page, 'filter.model')).toBe(1);
    await expect(shape).toHaveAttribute('aria-disabled', 'false');

    await page.getByTestId('seg-filter.model-0').click();
    expect(await busGet(page, 'filter.model')).toBe(0);
    await expect(shape).toHaveAttribute('aria-disabled', 'true');
  });

  test('a sequencer step toggles pattern state', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    const stepOn = () =>
      page.evaluate(() => (window as unknown as { __synth: { patterns: { seq: Array<Array<{ on: boolean }>> } } }).__synth.patterns.seq[0]![0]!.on);
    const before = await stepOn();
    await page.getByTestId('seq-step-0').click();
    expect(await stepOn()).toBe(!before);
  });

  test('an FX switch toggles its param', async ({ page }) => {
    await gotoAndStart(page);
    const sw = page.getByTestId('switch-fx.dist.on');
    const before = await busGet(page, 'fx.dist.on');
    await sw.click();
    expect(await busGet(page, 'fx.dist.on')).not.toBe(before);
  });

  test('the pulse-width knob is shown only for the square waveform', async ({ page }) => {
    await gotoAndStart(page);
    const width = page.getByTestId('knob-osc1.pulseWidth');
    // osc1.wave defaults to saw (2), where pulse width is meaningless.
    await expect(width).toBeHidden();

    await busSet(page, 'osc1.wave', 3); // square
    await expect(width).toBeVisible();

    await busSet(page, 'osc1.wave', 0); // sine
    await expect(width).toBeHidden();
  });

  // Both REQ-9 cues ride one lfo.dest subscription (oscillators.md), so they are
  // asserted together — a capped arc with no sentence beside it explaining it
  // would be worse than neither.
  test('the LFO rate cap is disclosed by both the hint and the knob arc', async ({ page }) => {
    await gotoAndStart(page);
    const hint = page.getByText('Pulse width follows the rate up to');
    const rate = page.getByTestId('knob-lfo.rate');
    await expect(hint).toBeHidden();
    await expect(rate).not.toHaveAttribute('data-uimax');

    await busSet(page, 'lfo.dest', 4); // pulse
    await expect(hint).toBeVisible();
    await expect(rate).toHaveAttribute('data-uimax', '10');

    // Paint only: the knob still reaches and stores the registered maximum.
    await busSet(page, 'lfo.rate', 20);
    expect(await busGet(page, 'lfo.rate')).toBe(20);

    await busSet(page, 'lfo.dest', 5); // pan — 20 Hz is genuinely live here
    await expect(hint).toBeHidden();
    await expect(rate).not.toHaveAttribute('data-uimax');
  });

  test('sampler slot handles are present', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await expect(page.getByTestId('sampler-record')).toBeVisible();
    await expect(page.getByTestId('sampler-load-0')).toBeVisible();
    await expect(page.getByTestId('sampler-name-0')).toBeVisible();
    // The ✎ edit button stays hidden until a buffer is loaded into the slot.
    await expect(page.getByTestId('sampler-edit-0')).toBeHidden();
  });
});
