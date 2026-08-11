import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * The mod matrix end to end (specs/features/mod-matrix.md).
 *
 * The unit tests pin the routing and the rule; these pin the parts only a real browser
 * has — that the launcher reaches the window, that one controller is shared, and that
 * a route actually reaches the audio graph.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const busSet = (page: import('@playwright/test').Page, id: string, v: number) =>
  page.evaluate(([i, x]) => (window as any).__synth.bus.set(i, x), [id, v] as [string, number]);

/** Open the Song tab, where the MOD launcher lives beside the XY Pad's. */
async function openMatrix(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('tab-song').click();
  await page.getByTestId('perf-mod').click();
  await expect(page.getByTestId('mod-window')).toBeVisible();
}

test.describe('mod matrix', () => {
  test('the launcher opens and closes one shared window', async ({ page }) => {
    await gotoAndStart(page);
    await openMatrix(page);
    // Toggling the same door closes it — and re-opening must not stack a second.
    await page.getByTestId('perf-mod').click();
    await expect(page.getByTestId('mod-window')).toBeHidden();
    await page.getByTestId('perf-mod').click();
    await expect(page.getByTestId('mod-window')).toHaveCount(1);
  });

  test('a route reaches the audio graph and can be taken down again', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'mod.0.src', 1);      // LFO 1
    await busSet(page, 'mod.0.dst', 2);      // resonance — unreachable before the matrix
    await busSet(page, 'mod.0.amt', 0.5);
    // The re-patch mutes, rewires, then ramps back, so poll to convergence.
    await expect.poll(() => page.evaluate(() =>
      (window as any).__synth.bus.get('mod.0.amt') as number)).toBe(0.5);

    await busSet(page, 'mod.0.src', 0);      // off
    await expect.poll(() => page.evaluate(() =>
      (window as any).__synth.bus.get('mod.0.src') as number)).toBe(0);
  });

  test('pan is greyed while the source is per-voice, and freed again', async ({ page }) => {
    await gotoAndStart(page);
    await openMatrix(page);

    const dst = page.getByTestId('mod-dst-2');
    await dst.locator('button').first().click();
    const pan = dst.locator('button').filter({ hasText: /^pan$/i });
    await expect(pan).toBeEnabled();

    await busSet(page, 'mod.0.src', 5);      // filter env — per-voice
    await expect(pan).toBeDisabled();
    await expect(pan).toBeVisible();          // greyed, never removed

    await busSet(page, 'mod.0.src', 1);      // LFO 1 — global
    await expect(pan).toBeEnabled();
  });

  test('both LFOs can now hold one destination (REQ-10)', async ({ page }) => {
    await gotoAndStart(page);
    await openMatrix(page);
    await busSet(page, 'lfo.dest', 1);       // cutoff
    const dst = page.getByTestId('mod-dst-1');
    await dst.locator('button').first().click();
    await expect(dst.locator('button').filter({ hasText: /^cutoff$/i })).toBeEnabled();
  });

  test('the MOD launcher carries an info badge (onboarding REQ-21)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    // The badge sits on its anchor, so the anchor has to be on screen — badges hide
    // with the control they annotate (onboarding.md REQ-5a).
    await page.getByTestId('perf-mod').scrollIntoViewIfNeeded();
    await page.getByTestId('info-badges').click();

    const badge = page.getByTestId('info-badge-mod');
    await expect(badge).toBeVisible();
    await badge.click();
    const modal = page.locator('.modal, [role="dialog"]').first();
    // The three things the window cannot say for itself.
    await expect(modal).toContainText('bipolar');
    await expect(modal).toContainText('green');
    await expect(modal).toContainText('Motion');
  });
});
