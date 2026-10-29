import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet, busSet } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The chorus, the flanger and their shared panel in a real browser — chorus.md,
 * flanger.md, fx-slot-picker.md.
 *
 * What only a browser settles: that the caret and the swapped views are really
 * laid out (jsdom has no CSS), that the fixed-position menu opens where it can
 * be clicked, that the switch reaches the engine's `Chorus` through the whole
 * ParamBus -> Effect chain, and that the flanger's lazy chunk and worklet really
 * load in a browser.
 */

/** What Song.apply does to the bus, without needing a song file. */
const load = (page: Page, params: Record<string, number>): Promise<void> =>
  page.evaluate((p) => {
    const bus = (window as any).__synth.bus;
    bus.resetDefaults();
    bus.restore(p);
  }, params);

test.describe('the Phaser / Chorus slot on the synth rack', () => {
  test.beforeEach(async ({ page }) => { await gotoAndStart(page); });

  test('the caret swaps the panel to the Chorus, which engages the effect', async ({ page }) => {
    const phaser = page.getByTestId('fxview-fx.phaser');
    const chorus = page.getByTestId('fxview-fx.chorus');
    await expect(phaser).toBeVisible();
    await expect(chorus).toBeHidden();

    await page.getByTestId('fxpick-fx.phaser').click();
    await page.getByTestId('fxpick-fx.phaser-fx.chorus').click();
    await expect(chorus).toBeVisible();
    await expect(phaser).toBeHidden();
    // The caret moved with the view, so it is beside the Chorus title now.
    await expect(chorus.getByTestId('fxpick-fx.phaser')).toBeVisible();

    await page.getByTestId('switch-fx.chorus.on').click();
    expect(await busGet(page, 'fx.chorus.on')).toBe(1);
    // The Phaser is untouched: both effects are independent.
    expect(await busGet(page, 'fx.phaser.on')).toBe(0);
    await expect(page.getByTestId('knob-fx.chorus.mode')).toBeVisible();
  });

  test('a load with only the chorus on shows the Chorus; with both, the Phaser', async ({ page }) => {
    await load(page, { 'fx.chorus.on': 1 });
    await expect(page.getByTestId('fxview-fx.chorus')).toBeVisible();
    await load(page, { 'fx.chorus.on': 1, 'fx.phaser.on': 1 });
    await expect(page.getByTestId('fxview-fx.phaser')).toBeVisible();
  });

  test('a preset MODE dims RATE and DEPTH', async ({ page }) => {
    await page.getByTestId('fxpick-fx.phaser').click();
    await page.getByTestId('fxpick-fx.phaser-fx.chorus').click();
    await busSet(page, 'fx.chorus.mode', 2);
    await expect(page.getByTestId('knob-fx.chorus.rate')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('knob-fx.chorus.depth')).toHaveAttribute('aria-disabled', 'true');
    await busSet(page, 'fx.chorus.mode', 0);
    await expect(page.getByTestId('knob-fx.chorus.rate')).toHaveAttribute('aria-disabled', 'false');
  });
});

/** Whether a chain's flanger has spliced its DSP in place of the wire (flanger.md REQ-the-flanger-loads-on-first-use). */
const flangerAttached = (page: Page, chain: 'synthFx' | 'samplerFx'): Promise<boolean> =>
  page.evaluate((c) => (window as any).__synth.engine[c].fx.flanger.live !== null, chain);

test.describe('the Flanger in the Phaser slot (flanger.md)', () => {
  test('lists Phaser, Flanger, Chorus; switching the Flanger on loads its worklet', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('fxpick-fx.phaser').click();
    const items = page.getByTestId('fxpick-fx.phaser').locator('..').getByRole('menuitem');
    await expect(items).toHaveText(['Phaser', 'Flanger', 'Chorus']);
    await page.getByTestId('fxpick-fx.phaser-fx.flanger').click();
    await expect(page.getByTestId('fxview-fx.flanger')).toBeVisible();

    expect(await flangerAttached(page, 'synthFx')).toBe(false);
    await page.getByTestId('switch-fx.flanger.on').click();
    expect(await busGet(page, 'fx.flanger.on')).toBe(1);
    await expect.poll(() => flangerAttached(page, 'synthFx')).toBe(true);
    // The sampler's flanger is its own: not loaded until it is asked for.
    expect(await flangerAttached(page, 'samplerFx')).toBe(false);
  });

  test('the sampler header lists the same three, in the same order', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('fxpick-fx.sampler.phaser').click();
    const items = page.getByTestId('fxpick-fx.sampler.phaser').locator('..').getByRole('menuitem');
    await expect(items).toHaveText(['Phaser', 'Flanger', 'Chorus']);
    await page.getByTestId('fxpick-fx.sampler.phaser-fx.sampler.flanger').click();
    await expect(page.getByTestId('fxgroup-fx.sampler.flanger')).toBeVisible();
    await expect(page.getByTestId('fxgroup-fx.sampler.phaser')).toBeHidden();
  });
});

test.describe('the PHASER / CHORUS slot in the sampler header', () => {
  test('swaps independently of the synth slot', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await expect(page.getByTestId('fxgroup-fx.sampler.phaser')).toBeVisible();
    await page.getByTestId('fxpick-fx.sampler.phaser').click();
    await page.getByTestId('fxpick-fx.sampler.phaser-fx.sampler.chorus').click();
    await expect(page.getByTestId('fxgroup-fx.sampler.chorus')).toBeVisible();
    await expect(page.getByTestId('fxgroup-fx.sampler.phaser')).toBeHidden();
    // The synth rack's slot did not move.
    await expect(page.getByTestId('fxview-fx.phaser')).toBeAttached();
    expect(await page.getByTestId('fxview-fx.phaser').evaluate((el) => (el as HTMLElement).hidden)).toBe(false);
  });
});
