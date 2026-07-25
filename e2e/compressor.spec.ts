import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet, dragKnobUp } from './helpers';

/**
 * The hardware-modelled compressors: the 1176-style unit in the Drum Machine
 * header and the SSL-bus-style unit in the Song panel's Live FX row. Audible
 * gain reduction isn't asserted (no deterministic program material under
 * headless Chromium) — state is verified through the ParamBus and the
 * dev-only `window.__synth` bridge, per house style.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const engineHas = (page: Page, key: string) =>
  page.evaluate((k) => Boolean((window as any).__synth.engine[k]), key);

test.describe('drum bus compressor (1176 FET style)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
  });

  test('the COMP group boots collapsed and engaging reveals knobs and GR meter', async ({ page }) => {
    // Bypassed by default: only the switch shows; knobs + meter stay in the
    // DOM but hidden (fx-group collapse).
    await expect(page.getByTestId('switch-fx.drum.comp.on')).toBeVisible();
    await expect(page.getByTestId('knob-fx.drum.comp.threshold')).toBeHidden();
    await expect(page.getByTestId('grmeter-fx.drum.comp')).toBeAttached();
    await expect(page.getByTestId('grmeter-fx.drum.comp')).toBeHidden();

    await page.getByTestId('switch-fx.drum.comp.on').click();
    for (const k of ['threshold', 'ratio', 'attack', 'release', 'makeup']) {
      await expect(page.getByTestId(`knob-fx.drum.comp.${k}`)).toBeVisible();
    }
    await expect(page.getByTestId('grmeter-fx.drum.comp')).toBeVisible();
  });

  test('the switch engages the compressor (default off)', async ({ page }) => {
    expect(await busGet(page, 'fx.drum.comp.on')).toBe(0);
    await page.getByTestId('switch-fx.drum.comp.on').click();
    expect(await busGet(page, 'fx.drum.comp.on')).toBe(1);
  });

  test('its help badge opens the 1176 explanation', async ({ page }) => {
    await page.getByTestId('help-button').click();
    await page.getByTestId('help-toggle-badges').click();
    const badge = page.getByTestId('help-badge-fx.drum.comp');
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page.getByRole('dialog', { name: 'Drum Compressor (1176 style)' })).toBeVisible();
  });

  test('threshold and ratio knobs drive the bus params', async ({ page }) => {
    await page.getByTestId('switch-fx.drum.comp.on').click(); // reveal the knobs
    await dragKnobUp(page, 'knob-fx.drum.comp.threshold');
    expect(await busGet(page, 'fx.drum.comp.threshold')).toBeGreaterThan(-18);

    expect(await busGet(page, 'fx.drum.comp.ratio')).toBe(0); // 4:1
    await dragKnobUp(page, 'knob-fx.drum.comp.ratio');
    expect(await busGet(page, 'fx.drum.comp.ratio')).toBeGreaterThan(0);
  });
});

test.describe('master bus compressor (SSL G VCA style)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
  });

  test('the COMP group renders next to the DJ filter, knobs behind the switch', async ({ page }) => {
    await expect(page.getByTestId('switch-fx.master.comp.on')).toBeVisible();
    await expect(page.getByTestId('knob-fx.master.comp.threshold')).toBeHidden(); // bypassed
    await page.getByTestId('switch-fx.master.comp.on').click();
    await expect(page.getByTestId('knob-fx.master.comp.threshold')).toBeVisible();
    await expect(page.getByTestId('grmeter-fx.master.comp')).toBeVisible();
  });

  test('both compressor instances live on the engine', async ({ page }) => {
    expect(await engineHas(page, 'drumComp')).toBe(true);
    expect(await engineHas(page, 'masterComp')).toBe(true);
  });

  test('its help badge opens the SSL explanation', async ({ page }) => {
    await page.getByTestId('help-button').click();
    await page.getByTestId('help-toggle-badges').click();
    // Badges are `position: fixed` and reflow on scroll, so one whose anchor is
    // below the fold cannot be scrolled into view directly — scroll the ANCHOR,
    // and the badge follows. Keeps this spec independent of where in the Song
    // panel the master COMP group happens to sit.
    await page.getByTestId('fxgroup-fx.master.comp').scrollIntoViewIfNeeded();
    const badge = page.getByTestId('help-badge-fx.master.comp');
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page.getByRole('dialog', { name: 'Master Compressor (SSL bus style)' })).toBeVisible();
  });

  test('switch and knobs drive the bus params (auto-release default)', async ({ page }) => {
    await page.getByTestId('switch-fx.master.comp.on').click();
    expect(await busGet(page, 'fx.master.comp.on')).toBe(1);

    expect(await busGet(page, 'fx.master.comp.release')).toBe(4); // index 4 = auto
    expect(await busGet(page, 'fx.master.comp.ratio')).toBe(1); // 4:1

    await dragKnobUp(page, 'knob-fx.master.comp.threshold');
    expect(await busGet(page, 'fx.master.comp.threshold')).toBeGreaterThan(-12);
  });
});
