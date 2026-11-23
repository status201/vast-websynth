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
// row then legitimately wraps under REQ-machine-header-wraps-at-every-width. Row membership is therefore asserted
// with real headroom, and the breakpoint rule itself is asserted from computed
// style, so neither depends on how wide a font renders.
//
// The headroom is sized from measurement, and the *fifth* group (DUCK,
// sidechain-ducking.md REQ-ducking-adds-no-new-gesture) moved it: five collapsed groups need 1580px
// before the row fits under Windows metrics, ~110px more than four did. CI's
// fonts need more still — 1600px, which used to clear four groups by 20px,
// wrapped there on all three attempts. The Sampler's record button, which now
// ends the FX cluster (REQ-the-record-button-ends-the-header), adds ~200px more to
// that one row, and 1900px was once seen to wrap under CI's fonts. This is
// deliberately far past all of that, since nothing but a headless viewport is
// being spent: the assertion is "given room to spare", so the width should not
// be a number the next group can creep up on.
const WIDE = { width: 2400, height: 900 };

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

    // REQ-below-1140-the-cluster-takes-its-own-row: below the wrap step the cluster claims a full-width row of its own.
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

    // REQ-above-1140-the-cluster-is-content-sized: above the wrap step the cluster is a plain content-sized run in DOM
    // order — REQ-below-1140-the-cluster-takes-its-own-row's `flex-basis: 100%` must not reach here, and it is never
    // right-aligned. Read from computed style, so a font that renders wider (and
    // legitimately wraps the row under REQ-machine-header-wraps-at-every-width) cannot turn this into a failure.
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

  // REQ-the-record-button-ends-the-header: the way into the sample studio ends the
  // header flush right, so no row above it is cut short by a reserved column, and
  // on a phone it is the header's last, full-width row.
  test('ends the header with the record button, reserving no column', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    const rec = page.getByTestId('sampler-record');
    const header = page.getByTestId('switch-sampler.on').locator('xpath=..');
    // The panel's content box: the header spanning it is what "no column" means.
    const panelContentRight = () => header.locator('xpath=..').evaluate((el) => {
      const cs = getComputedStyle(el);
      return el.getBoundingClientRect().right
        - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    });

    for (const size of [DESKTOP, TABLET]) {
      await page.setViewportSize(size);
      const r = (await rec.boundingBox())!;
      const h = (await header.boundingBox())!;
      // Its right edge is the header's right edge…
      expect(Math.abs((h.x + h.width) - (r.x + r.width))).toBeLessThanOrEqual(1);
      // …and the header spans the whole panel: nothing sits beside it.
      expect(Math.abs((h.x + h.width) - await panelContentRight())).toBeLessThanOrEqual(1);
      expect(r.height).toBeGreaterThanOrEqual(32);
      expect(await horizontalOverflow(page)).toBe(0);
    }

    // Below the wrap step, with every effect bypassed, it shares the last FX
    // group's line rather than costing a line of its own.
    await page.setViewportSize(TABLET);
    const r = (await rec.boundingBox())!;
    const duck = (await page.getByTestId(fxId('duck')).boundingBox())!;
    expect(r.y).toBeLessThan(duck.y + duck.height);
    expect(r.y + r.height).toBeGreaterThan(duck.y);

    // A phone: the last row, and the full width of it. "Below every other
    // control" is measured against everything else the header holds.
    await page.setViewportSize({ width: 375, height: 812 });
    const phone = (await rec.boundingBox())!;
    const h = (await header.boundingBox())!;
    const othersBottom = await header.evaluate((el, recId) => {
      let bottom = -Infinity;
      for (const c of el.querySelectorAll<HTMLElement>('[data-testid]')) {
        if (c.dataset.testid === recId || c.contains(document.querySelector(`[data-testid="${recId}"]`))) continue;
        const b = c.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) bottom = Math.max(bottom, b.bottom);
      }
      return bottom;
    }, 'sampler-record');
    expect(phone.y).toBeGreaterThanOrEqual(othersBottom - 1);
    expect(phone.width).toBeGreaterThanOrEqual(h.width - 2);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('keeps a bypassed group anchorable for its help badge', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    // fx-group REQ-help-badge-anchors-to-group-root: help must stay reachable for a bypassed effect, and
    // InfoBadges hides badges on zero-size anchors — so the root keeps a box
    // even though its knobs are hidden and the header has wrapped.
    const reverb = page.getByTestId(fxId('reverb'));
    await expect(page.getByTestId('knob-fx.sampler.reverb.mix')).toBeHidden();
    const box = (await reverb.boundingBox())!;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });
});
