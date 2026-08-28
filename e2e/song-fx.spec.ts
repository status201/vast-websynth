import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet, dragKnobUp } from './helpers';

/**
 * Live DJ FX on the Song panel. The momentary buttons (Fill/Stutter/Drop/Tape
 * Stop) fire on pointerdown and release on pointerup; the DJ filter knob and
 * Tape Stop have observable effects through the dev bridge (the djLow/djHigh
 * detune, `master.pitchBend`). Stutter/Fill are verified via their held `on`
 * class since their effect (step remap / drum roll) isn't directly observable here.
 *
 * The DJ filter is a SERIES lowpass -> highpass pair whose types never change
 * (performance.md REQ-9), so the observable is which side has moved off rest,
 * not a `.type` string. The sweep rides `detune` in cents and each side's
 * `frequency` is a fixed reference that is never written (REQ-10), so rest is
 * 0 cents on both — negative is the lowpass working, positive the highpass.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Which side of the DJ pair is engaged: 'lowpass' | 'highpass' | 'open'. */
const djMode = (page: Page) =>
  page.evaluate(() => {
    const e = (window as any).__synth.engine;
    // Cents off each side's reference frequency. The knob smooths with a time
    // constant, so the threshold is a comfortable way off zero rather than a
    // strict sign test — a settling sweep passes through small values.
    const lo = e.djLow.detune.value as number;
    const hi = e.djHigh.detune.value as number;
    if (hi > 100) return 'highpass';
    if (lo < -100) return 'lowpass';
    return 'open';
  });

test.describe('song panel live FX', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
  });

  // Both sides move by retargeting `detune`, never by a type flip (performance.md
  // REQ-9/REQ-10), so every assertion here polls: `setTargetAtTime` approaches
  // its target rather than arriving, over ~60 ms for the knob and ~500 ms for
  // Filter Drop. Reading once immediately after the gesture races the curve.
  test('the DJ filter knob sweeps the master pair into a highpass', async ({ page }) => {
    await dragKnobUp(page, 'knob-fx.djfilter');
    expect(await busGet(page, 'fx.djfilter')).toBeGreaterThan(0);
    await expect.poll(() => djMode(page)).toBe('highpass');
  });

  test('Filter Drop overrides the knob while held and restores on release', async ({ page }) => {
    await dragKnobUp(page, 'knob-fx.djfilter'); // park the knob in highpass
    await expect.poll(() => djMode(page)).toBe('highpass');

    const drop = page.getByTestId('perf-drop');
    await drop.dispatchEvent('pointerdown');
    // The drop OVERRIDES the knob: the highpass side opens back out as the
    // lowpass dives, so the dive is not band-passed by the knob's position.
    await expect.poll(() => djMode(page)).toBe('lowpass');
    await drop.dispatchEvent('pointerup');
    await expect.poll(() => djMode(page)).toBe('highpass'); // back to the knob position
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
