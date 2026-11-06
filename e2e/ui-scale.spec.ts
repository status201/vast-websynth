// UI scale: the Settings slider zooms the whole app, a reload restores it before
// first paint, and positioned things still land where they belong
// (specs/features/ui-scale.md).
import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

const SHIPPED = 'width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no';

/** Store a scale before any page script runs, as a returning visitor has it. */
const withStoredScale = (page: Page, pct: number) =>
  page.addInitScript((p) => localStorage.setItem('websynth.ui.scale', String(p)), pct);

/** The zoom on <html> the first time the parser reaches a stylesheet: the boot
 *  script ran by then or it did not (REQ-the-scale-applies-before-first-paint). */
const watchFirstSheet = () => {
  const w = window as unknown as { __zoomAtFirstSheet?: string };
  new MutationObserver((_r, obs) => {
    if (!document.querySelector('link[rel="stylesheet"], style')) return;
    w.__zoomAtFirstSheet = document.documentElement.style.getPropertyValue('zoom');
    obs.disconnect();
  }).observe(document, { childList: true, subtree: true });
};

/** Open Settings, through the phone header's hamburger when the layout put it there. */
async function openSettings(page: Page): Promise<void> {
  const menu = page.getByTestId('header-menu');
  if (await menu.isVisible()) await menu.click();
  await page.getByTestId('perf-settings').click();
}

const settingsSlider = async (page: Page) => {
  await openSettings(page);
  return page.getByTestId('ui-scale-slider');
};

test.describe('desktop: the zoom engine', () => {
  test('100% touches nothing (REQ-a-hundred-percent-is-a-no-op)', async ({ page }) => {
    await gotoAndStart(page);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', SHIPPED);
    expect(await page.evaluate(() => document.documentElement.getAttribute('style'))).toBeNull();
  });

  test('a picked size applies on release, survives a reload, and is on before the first stylesheet', async ({ page }) => {
    await gotoAndStart(page);
    // A fixed-size control: a knob's size is responsive, and 125% of 1440 px is
    // the compact layout, exactly as under the browser's own zoom.
    const gauge = page.getByTestId('panic');
    const before = (await gauge.boundingBox())!.height;

    const slider = await settingsSlider(page);
    await slider.focus();
    await page.keyboard.press('ArrowRight'); // 110
    await page.keyboard.press('ArrowRight'); // 125
    await expect(page.getByTestId('ui-scale-value')).toHaveText('125%');
    expect(await page.evaluate(() => localStorage.getItem('websynth.ui.scale'))).toBe('125');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('zoom'))).toBe('1.25');
    await page.keyboard.press('Escape');

    const after = (await gauge.boundingBox())!.height;
    expect(after / before).toBeCloseTo(1.25, 1);

    await page.addInitScript(watchFirstSheet);
    await page.reload();
    const first = await page.evaluate(() => (window as unknown as { __zoomAtFirstSheet?: string }).__zoomAtFirstSheet);
    expect(first).toBe('1.25');
  });

  test('150% on a 1366 px window reflows into the compact layout (REQ-breakpoints-follow-the-effective-width)', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await withStoredScale(page, 150);
    await gotoAndStart(page);
    // Nothing overflows sideways: the layout chose the ≤1280 px arrangement for its 911 px.
    const overflow = await page.evaluate(() => {
      const app = document.querySelector('.app') as HTMLElement;
      return app.scrollWidth - app.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth + 1)).toBe(true);
  });

  test('a menu opens under its toggle at 150% (REQ-coordinates-are-converted-at-the-read)', async ({ page }) => {
    await withStoredScale(page, 150);
    await gotoAndStart(page);
    await page.getByTestId('tab-key').click();
    const dd = page.getByTestId('key-scale');
    await dd.click();
    const option = dd.locator('.dropdown-option').first();
    await expect(option).toBeVisible();
    const toggle = (await dd.boundingBox())!;
    const menu = await option.evaluate((el) => {
      let m: HTMLElement | null = el as HTMLElement;
      while (m && getComputedStyle(m).position !== 'fixed') m = m.parentElement;
      const r = m!.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    expect(Math.abs(menu.left - toggle.x)).toBeLessThanOrEqual(2);
    // 6 local px of gap, drawn at 150% (or flipped above when there is no room below).
    const below = Math.abs(menu.top - (toggle.y + toggle.height + 9)) <= 2;
    const above = menu.top < toggle.y;
    expect(below || above).toBe(true);
  });

  test('a floating window drags 1:1 with the pointer at 150% (REQ-coordinates-are-converted-at-the-read)', async ({ page }) => {
    // Wide enough that 150% still leaves the full layout (2000 / 1.5 > 1280), where the launcher shows.
    await page.setViewportSize({ width: 2000, height: 1100 });
    await withStoredScale(page, 150);
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('perf-xypad').click();
    const win = page.getByTestId('xypad-window');
    await expect(win).toBeVisible();
    const bar = win.locator(':scope > div').first();
    const b0 = (await win.boundingBox())!;
    const h = (await bar.boundingBox())!;
    const x = h.x + h.width / 2; // the middle of the bar: its left end is the minimise button, which stops a drag
    const y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y + 10, { steps: 5 });
    await page.mouse.move(x + 100, y + 20, { steps: 5 });
    await page.mouse.up();
    const b1 = (await win.boundingBox())!;
    expect(b1.x - b0.x).toBeCloseTo(100, -1);
    expect(b1.y - b0.y).toBeCloseTo(20, -1);
  });

  test('Reset returns to exactly the shipped page', async ({ page }) => {
    await withStoredScale(page, 67);
    await gotoAndStart(page);
    await openSettings(page);
    await expect(page.getByTestId('ui-scale-value')).toHaveText('67%');
    await page.getByTestId('ui-scale-reset').click();
    await expect(page.getByTestId('ui-scale-value')).toHaveText('100%');
    await expect(page.getByTestId('ui-scale-reset')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.getAttribute('style'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('websynth.ui.scale'))).toBeNull();
  });
});

test.describe('touch: the viewport engine', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('80% widens the layout viewport and zooms nothing (REQ-one-value-two-engines)', async ({ page }) => {
    await withStoredScale(page, 80);
    await gotoAndStart(page);
    const s = await page.evaluate(() => ({
      innerWidth,
      zoom: document.documentElement.style.getPropertyValue('zoom'),
      viewport: document.querySelector('meta[name="viewport"]')!.getAttribute('content'),
    }));
    expect(s.innerWidth).toBeGreaterThanOrEqual(486);
    expect(s.innerWidth).toBeLessThanOrEqual(489);
    expect(s.zoom).toBe('');
    expect(s.viewport).toContain('initial-scale=0.8');
  });

  test('back to 100% restores the shipped tag', async ({ page }) => {
    await withStoredScale(page, 125);
    await gotoAndStart(page);
    expect(await page.evaluate(() => innerWidth)).toBe(312);
    await openSettings(page);
    await page.getByTestId('ui-scale-reset').click();
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', SHIPPED);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(390);
  });
});
