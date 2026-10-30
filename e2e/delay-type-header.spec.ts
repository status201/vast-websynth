import { test, expect } from '@playwright/test';
import { gotoAndStart, busSet } from './helpers';

/**
 * delay-types.md REQ-type-is-a-header-dropdown-and-char-a-knob (v4, regression):
 * the synth Delay panel's title is the TYPE dropdown, so its header fits the
 * panel. A separate 120 px box beside the title pushed the ON switch out of the
 * panel at 1200 px and covered it at 393 px. Measured rather than asserted from
 * classes: the failure is geometry. `.fxPanel` carries no testid, so the panel
 * is recovered as the rack grid's cell (the `fx` section's last child) holding
 * the switch, as responsive-panels.spec.ts does.
 */
test('the Delay header fits its panel at narrow widths', async ({ page }) => {
  await gotoAndStart(page);
  await busSet(page, 'fx.delay.on', 1);
  await busSet(page, 'fx.delay.type', 4); // SPACE ECHO, the longest label
  await expect(page.getByTestId('dropdown-fx.delay.type')).toContainText('SPACE ECHO');

  for (const width of [393, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    const m = await page.evaluate(() => {
      const sw = document.querySelector('[data-testid="switch-fx.delay.on"]') as HTMLElement | null;
      const dd = document.querySelector('[data-testid="dropdown-fx.delay.type"] button') as HTMLElement | null;
      if (!sw || !dd) throw new Error('no Delay switch or TYPE toggle on the faceplate');
      const grid = document.querySelector('[data-testid="fx"]')!.lastElementChild!;
      const panel = [...grid.children].find((c) => c.contains(sw))!;
      const r = (el: Element) => el.getBoundingClientRect();
      return { sw: r(sw).toJSON(), dd: r(dd).toJSON(), panel: r(panel).toJSON() };
    });
    expect(m.sw.right, `switch inside the panel at ${width}px`).toBeLessThanOrEqual(m.panel.right);
    expect(m.dd.left, `title inside the panel at ${width}px`).toBeGreaterThanOrEqual(m.panel.left);
    expect(m.dd.right, `title clear of the switch at ${width}px`).toBeLessThanOrEqual(m.sw.left);
  }
});
