import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busSet } from './helpers';

/**
 * Responsive machine header — the pattern panel's control row (machine on/off,
 * MASTER, bank bar, undo, actions + the inline FX groups) wraps instead of
 * clipping, and below the 1140px wrap step the FX cluster takes its own row so
 * the machine controls never reflow around an individual effect group.
 * See specs/features/responsive-machine-header.md.
 */
const DESKTOP = { width: 1280, height: 900 };
// Below the 1140px wrap step, where the FX cluster claims its own row.
const TABLET = { width: 1024, height: 768 };
// Comfortably above the wrap step. 1280 is the *top of the breakpoint cascade*,
// not a width where the wide row is guaranteed to fit: the sampler's machine
// controls plus its collapsed fx groups leave only a sliver of slack there under
// Windows font metrics, and none under the wider fonts on CI Linux — where the
// row then legitimately wraps under REQ-1. Row membership is therefore asserted
// with real headroom, and the breakpoint rule itself is asserted from computed
// style, so neither depends on how wide a font renders.
//
// The headroom is sized from measurement, and the *fifth* group (DUCK,
// sidechain-ducking.md REQ-10) moved it: five collapsed groups need 1580px
// before the row fits under Windows metrics, ~110px more than four did. CI's
// fonts need more still — 1600px, which used to clear four groups by 20px,
// wrapped there on all three attempts. This is deliberately far past both, since
// nothing but a headless viewport is being spent: the assertion is "given room
// to spare", so the width should not be a number the next group can creep up on.
const WIDE = { width: 1900, height: 900 };

const SAMPLER_FX = ['dist', 'phaser', 'delay', 'reverb'] as const;
const fxId = (name: string) => `fxgroup-fx.sampler.${name}`;

/** Engage every sampler effect — the worst case, ~1450px of min-content. */
async function engageAllFx(page: Page): Promise<void> {
  for (const name of SAMPLER_FX) await busSet(page, `fx.sampler.${name}.on`, 1);
  // The last group's knobs appearing means every group has re-laid out.
  await expect(page.getByTestId('knob-fx.sampler.reverb.mix')).toBeVisible();
}

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });

test.describe('responsive machine header', () => {
  test('never overflows with every effect engaged at 1024px', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await engageAllFx(page);

    expect(await horizontalOverflow(page)).toBe(0);

    // Every group sits fully inside the viewport's horizontal bounds. Checked
    // on x alone, not toBeInViewport: the page scrolls vertically by design, so
    // the wrapped FX row can legitimately sit below the fold — this spec is
    // about horizontal clipping.
    for (const name of SAMPLER_FX) {
      const box = (await page.getByTestId(fxId(name)).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(TABLET.width);
    }
  });

  test('gives the FX cluster its own row below the wrap step', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await engageAllFx(page);

    // REQ-3: below the wrap step the cluster claims a full-width row of its own.
    // The mirror of the DESKTOP assertion below — together they pin the media
    // query from both sides.
    const cluster = page.getByTestId(fxId('dist')).locator('xpath=..');
    expect(await cluster.evaluate((el) => getComputedStyle(el).flexBasis)).toBe('100%');

    // The machine controls share no row with any effect group: every group
    // starts at or below the bottom of the machine on/off switch.
    const machine = (await page.getByTestId('switch-sampler.on').boundingBox())!;
    for (const name of SAMPLER_FX) {
      const fx = (await page.getByTestId(fxId(name)).boundingBox())!;
      expect(fx.y).toBeGreaterThanOrEqual(machine.y + machine.height - 1);
    }
  });

  test('leaves the wide layout on a single row', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    // REQ-4: above the wrap step the cluster is a plain content-sized run in DOM
    // order — REQ-3's `flex-basis: 100%` must not reach here, and it is never
    // right-aligned. Read from computed style, so a font that renders wider (and
    // legitimately wraps the row under REQ-1) cannot turn this into a failure.
    const cluster = page.getByTestId(fxId('dist')).locator('xpath=..');
    expect(await cluster.evaluate((el) => getComputedStyle(el).flexBasis)).toBe('auto');
    expect(await cluster.evaluate((el) => getComputedStyle(el).marginLeft)).not.toBe('auto');
    expect(await horizontalOverflow(page)).toBe(0);

    // And given room to spare, effects bypassed (the default), the first FX
    // group shares the machine controls' row exactly as before.
    await page.setViewportSize(WIDE);
    const machine = (await page.getByTestId('switch-sampler.on').boundingBox())!;
    const dist = (await page.getByTestId(fxId('dist')).boundingBox())!;
    expect(dist.y).toBeLessThan(machine.y + machine.height);
    expect(dist.y + dist.height).toBeGreaterThan(machine.y);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('keeps a bypassed group anchorable for its help badge', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    // fx-group REQ-5: help must stay reachable for a bypassed effect, and
    // InfoBadges hides badges on zero-size anchors — so the root keeps a box
    // even though its knobs are hidden and the header has wrapped.
    const reverb = page.getByTestId(fxId('reverb'));
    await expect(page.getByTestId('knob-fx.sampler.reverb.mix')).toBeHidden();
    const box = (await reverb.boundingBox())!;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });
});
