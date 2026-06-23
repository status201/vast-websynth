import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet } from './helpers';

// The Song tab's per-lane DJ mixer: mute / solo / volume for the sequencer,
// drum machine and sampler, operable without leaving the Song tab. The volume
// knob binds to the same `<lane>.master` param the per-machine panel exposes,
// so controls are scoped to the lane card (the testid intentionally repeats).
test.describe('song-tab lane mixer', () => {
  const LANES = ['seq', 'drum', 'sampler'] as const;

  const lane = (page: Page, id: string) => page.getByTestId(`song-lane-${id}`);

  const opacity = (page: Page, id: string): Promise<number> =>
    page.evaluate((l) => {
      const el = document.querySelector(`[data-testid="song-lane-${l}"]`) as HTMLElement;
      return parseFloat(getComputedStyle(el).opacity);
    }, id);

  test('mute / solo / volume controls exist for every lane', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    for (const id of LANES) {
      await expect(lane(page, id).getByTestId(`switch-${id}.mute`)).toBeVisible();
      await expect(lane(page, id).getByTestId(`switch-${id}.solo`)).toBeVisible();
      await expect(lane(page, id).getByTestId(`knob-${id}.master`)).toBeVisible();
    }
  });

  test('mute toggles the lane param and dims only that lane', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    await page.getByTestId('switch-drum.mute').click();
    await expect.poll(() => busGet(page, 'drum.mute')).toBe(1);

    // Only the muted lane dims; the others stay full opacity.
    await expect.poll(() => opacity(page, 'drum')).toBeLessThan(0.6);
    expect(await opacity(page, 'seq')).toBe(1);
    expect(await opacity(page, 'sampler')).toBe(1);
  });

  test('solo silences the other lanes (mute on a soloed lane is ignored)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    await page.getByTestId('switch-seq.solo').click();
    await expect.poll(() => busGet(page, 'seq.solo')).toBe(1);

    // Soloed lane audible; the other two dim.
    expect(await opacity(page, 'seq')).toBe(1);
    await expect.poll(() => opacity(page, 'drum')).toBeLessThan(0.6);
    await expect.poll(() => opacity(page, 'sampler')).toBeLessThan(0.6);
  });

  test('volume knob is bound to the lane master gain', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    const knob = lane(page, 'sampler').getByTestId('knob-sampler.master');
    await expect(knob).toBeVisible();
    const box = await knob.boundingBox();
    if (!box) throw new Error('sampler volume knob has no bounding box');

    const before = await busGet(page, 'sampler.master');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 6 }); // drag up = increase
    await page.mouse.up();

    await expect.poll(() => busGet(page, 'sampler.master')).toBeGreaterThan(before);
  });
});
