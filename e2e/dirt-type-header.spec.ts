import { test, expect } from '@playwright/test';
import { gotoAndStart, busGet, busSet } from './helpers';

/**
 * dirt-types.md REQ-dirt-type-is-the-panel-title: the synth Dirt panel's title
 * is the TYPE dropdown, so its header must fit the panel at every width — the
 * geometry the Delay's title once broke (delay-type-header.spec.ts), and that a
 * "Distortion" legend broke again: legend and value both too long, the ON
 * switch pushed out of the panel and the value unable to truncate (regression).
 * DISTORTION is the longest value. The panel is recovered as the rack grid's
 * cell holding the switch, as that spec does.
 */
test('the Dirt header fits its panel at every width', async ({ page }) => {
  await gotoAndStart(page);
  await busSet(page, 'fx.dist.on', 1);
  await expect(page.getByTestId('dropdown-fx.dist.type')).toContainText('DISTORTION');

  for (const width of [360, 393, 480, 600, 660, 768, 900, 1024, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const m = await page.evaluate(() => {
      const sw = document.querySelector('[data-testid="switch-fx.dist.on"]') as HTMLElement | null;
      const dd = document.querySelector('[data-testid="dropdown-fx.dist.type"] button') as HTMLElement | null;
      if (!sw || !dd) throw new Error('no Dirt switch or TYPE toggle on the faceplate');
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

test('choosing a type from the sampler DIRT group sets it', async ({ page }) => {
  await gotoAndStart(page);
  await page.getByTestId('tab-sampler').click();
  await busSet(page, 'fx.sampler.dist.on', 1);
  const dd = page.getByTestId('dropdown-fx.sampler.dist.type');
  await dd.locator('button').first().click();
  await dd.getByText('OVERDRIVE', { exact: true }).click();
  await expect(dd).toContainText('OVERDRIVE');
  expect(await busGet(page, 'fx.sampler.dist.type')).toBe(1);
});
