import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet, dragKnobUp } from './helpers';

/**
 * Live DJ FX on the Song panel. The momentary buttons (Fill/Stutter/Drop/Tape
 * Stop) fire on pointerdown and release on pointerup; the DJ filter knob and
 * Tape Stop have observable effects through the dev bridge (`djFilter.type`,
 * `master.pitchBend`). Stutter/Fill are verified via their held `on` class
 * since their effect (step remap / drum roll) isn't directly observable here.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const djType = (page: Page) =>
  page.evaluate(() => (window as any).__synth.engine.djFilter.type as string);

test.describe('song panel live FX', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
  });

  test('the DJ filter knob sweeps the master djFilter into a highpass', async ({ page }) => {
    await dragKnobUp(page, 'knob-fx.djfilter');
    expect(await busGet(page, 'fx.djfilter')).toBeGreaterThan(0);
    expect(await djType(page)).toBe('highpass');
  });

  test('Filter Drop overrides the knob while held and restores on release', async ({ page }) => {
    await dragKnobUp(page, 'knob-fx.djfilter'); // park the knob in highpass
    expect(await djType(page)).toBe('highpass');

    const drop = page.getByTestId('perf-drop');
    await drop.dispatchEvent('pointerdown');
    expect(await djType(page)).toBe('lowpass'); // drop dives to a lowpass
    await drop.dispatchEvent('pointerup');
    expect(await djType(page)).toBe('highpass'); // back to the knob position
  });

  test('Tape Stop bends the pitch down while held and recovers on release', async ({ page }) => {
    const tape = page.getByTestId('perf-tapestop');
    await tape.dispatchEvent('pointerdown');
    await expect.poll(() => busGet(page, 'master.pitchBend')).toBeLessThan(0);
    await tape.dispatchEvent('pointerup');
    await expect.poll(() => busGet(page, 'master.pitchBend')).toBeGreaterThanOrEqual(0);
  });

  test('Stutter toggles its held state and its size selector activates', async ({ page }) => {
    const stutter = page.getByTestId('perf-stutter');
    await stutter.dispatchEvent('pointerdown');
    await expect(stutter).toHaveClass(/\bon\b/);
    await stutter.dispatchEvent('pointerup');
    await expect(stutter).not.toHaveClass(/\bon\b/);

    await page.getByTestId('perf-stutter-size-4').click();
    await expect(page.getByTestId('perf-stutter-size-4')).toHaveClass(/\bactive\b/);
  });

  test('Fill is a momentary toggle', async ({ page }) => {
    const fill = page.getByTestId('perf-fill');
    await fill.dispatchEvent('pointerdown');
    await expect(fill).toHaveClass(/\bon\b/);
    await fill.dispatchEvent('pointerup');
    await expect(fill).not.toHaveClass(/\bon\b/);
  });
});
