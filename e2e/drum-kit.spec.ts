import { test, expect } from '@playwright/test';
import { gotoAndStart, busGet, busSet } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The drum panel's per-drum sound design: a selected-drum tuning strip
 * (tune/decay/tone/drive/pan/vol + Reset), plus the header KIT dropdown and
 * Randomize button. All of it flows UI → bus.set, read back via the dev bridge.
 */
test.describe('drum kits & per-drum tuning', () => {
  test('the tuning strip exposes per-drum knobs and retargets on selection', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    // Track 0 is selected by default → its channel knobs are present.
    await expect(page.getByTestId('knob-drum.t0.tone')).toBeVisible();
    await expect(page.getByTestId('knob-drum.t0.drive')).toBeVisible();
    await expect(page.getByTestId('knob-drum.t0.pan')).toBeVisible();

    // Clicking another drum's label retargets the strip to that track.
    await page.getByTestId('drum-track-2').click();
    await expect(page.getByTestId('knob-drum.t2.tone')).toBeVisible();
  });

  test('reset restores the selected track to its defaults', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    await busSet(page, 'drum.t0.drive', 0.6);
    expect(await busGet(page, 'drum.t0.drive')).toBeCloseTo(0.6);

    // Track 0 is selected by default; Reset returns its params to defaults.
    await page.getByTestId('drum-reset').click();
    expect(await busGet(page, 'drum.t0.drive')).toBe(0);
  });

  test('randomize moves per-track params off their defaults', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    await page.getByTestId('drum-randomize').click();
    const changed = await page.evaluate(() => {
      const bus = (window as any).__synth.bus;
      let n = 0;
      for (let i = 0; i < 8; i++) {
        for (const p of ['tune', 'decay', 'tone', 'drive', 'pan']) {
          const id = `drum.t${i}.${p}`;
          if (bus.get(id) !== bus.def(id).default) n++;
        }
      }
      return n;
    });
    expect(changed).toBeGreaterThan(0);
  });

  test('selecting a kit applies its per-track values', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    const select = page.getByTestId('drum-kit');
    await select.click(); // open the popover
    await select.getByText('808', { exact: true }).click();

    // The 808 kit tunes the kick (track 0) down.
    await expect.poll(() => busGet(page, 'drum.t0.tune')).toBeLessThan(0);
  });
});
