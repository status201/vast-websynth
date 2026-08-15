import { test, expect } from '@playwright/test';
import { gotoAndStart, busSet } from './helpers';
import { SYNC_LABELS } from '../src/utils/tempo';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * LFO tempo lock — lfo.md REQ-9. A free-running LFO drifts against the song: set
 * a wobble at 120 BPM, change to 128, and it lines up with nothing.
 *
 * The rate is asserted on the LFO oscillator's own frequency, which is the
 * audible thing; `rampTo` is a `setTargetAtTime`, so it is polled to convergence
 * rather than read once.
 */
const QUARTER = SYNC_LABELS.indexOf('1/4');
const EIGHTH = SYNC_LABELS.indexOf('1/8');

const lfoHz = (page: any): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.lfo.osc.frequency.value as number);

test.describe('LFO tempo sync', () => {
  test('a synced LFO takes its rate from the tempo, and follows a tempo change', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'transport.bpm', 120);
    await busSet(page, 'lfo.rate', 7); // a deliberately unrelated knob value

    await busSet(page, 'lfo.sync', QUARTER);
    // 1/4 at 120 BPM = 0.5 s = 2 Hz.
    await expect.poll(() => lfoHz(page), { timeout: 4000 }).toBeCloseTo(2, 1);

    // Halving the tempo halves the rate — with nothing else touched.
    await busSet(page, 'transport.bpm', 60);
    await expect.poll(() => lfoHz(page), { timeout: 4000 }).toBeCloseTo(1, 1);

    // A finer division is faster at the same tempo.
    await busSet(page, 'transport.bpm', 120);
    await busSet(page, 'lfo.sync', EIGHTH);
    await expect.poll(() => lfoHz(page), { timeout: 4000 }).toBeCloseTo(4, 1);
  });

  test('going back to free restores the knob\'s own rate (ADR-006)', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'transport.bpm', 120);
    await busSet(page, 'lfo.rate', 7);
    await busSet(page, 'lfo.sync', QUARTER);
    await expect.poll(() => lfoHz(page), { timeout: 4000 }).toBeCloseTo(2, 1);

    await busSet(page, 'lfo.sync', 0); // free
    // The stored rate was never rewritten, so this is exactly where it came from.
    await expect.poll(() => lfoHz(page), { timeout: 4000 }).toBeCloseTo(7, 1);
    expect(await page.evaluate(() => (window as any).__synth.bus.get('lfo.rate'))).toBeCloseTo(7, 5);
  });

  // v9: the picker no longer sits two rows below the knob, so the knob is no
  // longer dimmed in place beside it — it becomes the picker (tempo-lock.md
  // REQ-3). The knob keeps its testid, its footprint and its stored value.
  test('the rate knob shows the division while synced, and the dial comes back on free', async ({ page }) => {
    await gotoAndStart(page);
    const knob = page.getByTestId('knob-lfo.rate');
    const chip = page.getByTestId('tempodiv-lfo.rate');
    await expect(chip).toBeHidden();

    await busSet(page, 'transport.bpm', 120);
    await busSet(page, 'lfo.sync', QUARTER);

    await expect(chip).toBeVisible();
    // Scoped to the toggle's label span: the chip also holds the closed menu, and
    // the toggle also holds the caret (hidden, but still in `textContent`).
    await expect(chip.locator('button > span').first()).toHaveText('1/4');
    await expect(knob).toBeVisible();
    // The readout shows what is actually heard: 1/4 at 120 BPM is 2 Hz.
    await expect(knob).toContainText('2.00Hz');

    await busSet(page, 'lfo.sync', 0);
    await expect(chip).toBeHidden();
  });

  test('the note glyph locks and unlocks without moving the stored rate', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'transport.bpm', 120);
    await busSet(page, 'lfo.rate', 7);
    const lock = page.getByTestId('tempolock-lfo.rate');
    await expect(lock).toHaveAttribute('aria-pressed', 'false');

    await lock.click();
    await expect(lock).toHaveAttribute('aria-pressed', 'true');
    // Engaging picks the division nearest 7 Hz, so the wobble does not jump.
    await expect.poll(() => lfoHz(page), { timeout: 4000 }).toBeCloseTo(8, 0);

    await lock.click();
    await expect(lock).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => lfoHz(page), { timeout: 4000 }).toBeCloseTo(7, 1);
    expect(await page.evaluate(() => (window as any).__synth.bus.get('lfo.rate'))).toBeCloseTo(7, 5);
  });

  test('free-running is the default, so nothing changes until you ask', async ({ page }) => {
    await gotoAndStart(page);
    expect(await page.evaluate(() => (window as any).__synth.bus.get('lfo.sync'))).toBe(0);
    await busSet(page, 'transport.bpm', 96);
    await busSet(page, 'lfo.rate', 3);
    // A tempo change must not move a free-running LFO.
    await expect.poll(() => lfoHz(page), { timeout: 4000 }).toBeCloseTo(3, 1);
  });
});
