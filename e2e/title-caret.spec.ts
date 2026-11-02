import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * iconography.md REQ-a-title-caret-is-cap-high (v7, regression): the caret
 * beside the DIRT / DELAY legend stands on the legend's baseline, so its
 * cap-high glyph tops out at the capitals' top. The grid row used to centre it,
 * and Georgia's capitals sit above the line box's middle, so its top landed
 * 0.77px below DELAY's (Chromium; 0.38px in Firefox).
 *
 * Measured, not read from classes: the bug is a sub-pixel offset. The legend's
 * baseline and cap top come from a probe inside it, an inline-block `1cap` tall
 * on the baseline, so the browser's own cap metric is the reference and no font
 * metric is hard-coded. The glyph is the caret SVG's path. Measured open too:
 * the caret turns about the glyph's centre, so the menu must not move it.
 *
 * At ~1x it stands 1px higher than that: hinting snaps the 8px capitals onto
 * whole pixels and they draw above their metric top, so the exact caret read a
 * pixel low on the user's 100% screens. 2x is the metric fit, exact.
 */
const TITLED = ['dropdown-fx.dist.type', 'dropdown-fx.delay.type'];

const measure = (page: Page, testId: string) => page.evaluate((id) => {
  const toggle = document.querySelector(`[data-testid="${id}"] button`) as HTMLElement | null;
  const caret = toggle?.querySelector('.cap-caret');
  const legend = toggle?.firstElementChild as HTMLElement | null;
  const glyph = caret?.querySelector('path');
  if (!toggle || !caret || !legend || !glyph || legend === caret) throw new Error(`no legend + caret in ${id}`);
  const probe = document.createElement('span');
  probe.style.display = 'inline-block';
  probe.style.width = '0';
  probe.style.height = '1cap';
  legend.appendChild(probe);
  const p = probe.getBoundingClientRect();
  probe.remove();
  const g = glyph.getBoundingClientRect();
  return { capTop: p.top, baseline: p.bottom, top: g.top, bottom: g.bottom };
}, testId);

for (const [dpr, lift] of [[1, 1], [2, 0]] as const) {
  test.describe(`at ${dpr}x`, () => {
    test.use({ deviceScaleFactor: dpr });

    test('the titled dropdown caret tops out at the legend\'s cap top', async ({ page }) => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await gotoAndStart(page);

      for (const id of TITLED) {
        const m = await measure(page, id);
        expect(Math.abs(m.bottom + lift - m.baseline), `${id}: glyph bottom ${lift}px over the baseline`).toBeLessThan(0.25);
        expect(Math.abs(m.top + lift - m.capTop), `${id}: glyph top ${lift}px over the cap top`).toBeLessThan(0.25);
      }

      // Open: the rotation turns about the glyph's own centre, so nothing moves.
      const id = TITLED[1]!;
      const before = await measure(page, id);
      await page.locator(`[data-testid="${id}"] button`).first().click(); // the toggle; the menu options are buttons too
      await expect(page.getByTestId(id)).toHaveClass(/\bopen\b/);
      await expect.poll(async () => {
        const open = await measure(page, id);
        return Math.max(Math.abs(open.top - before.top), Math.abs(open.bottom - before.bottom));
      }, { message: `${id}: the open caret stays put` }).toBeLessThan(0.25);
    });
  });
}
