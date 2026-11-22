import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/**
 * sample-recorder.md REQ-the-tools-are-tabs — the studio's tools are five tabs
 * under an always-visible waveform: one page at a time, Effects first.
 *
 * This is the only spec that asserts the tabs themselves; `sample-chop.spec.ts`,
 * `time-stretch.spec.ts` and `scratch.spec.ts` pick their tab and get on with
 * their own feature.
 */
const PAGES = ['effects', 'chop', 'stretch', 'scratch', 'vocoder'] as const;

/** Load a clip into slot 0 and open it in the editor. */
async function openEditor(page: Page): Promise<void> {
  await gotoAndStart(page);
  await page.getByTestId('tab-sampler').click();
  await page.getByTestId('sampler-file-0').setInputFiles({
    name: 'break.wav', mimeType: 'audio/wav', buffer: makeWavBuffer(2.0),
  });
  await expect(page.getByTestId('sampler-name-0')).toHaveText('break.wav');
  await page.getByTestId('sampler-edit-0').click();
  await expect(page.getByTestId('rec-screen-edit')).toBeVisible();
}

test.describe('sample studio — tool tabs', () => {
  test('opens on Effects, one page at a time (REQ-the-tools-are-tabs)', async ({ page }) => {
    await openEditor(page);
    await expect(page.getByTestId('ppage-sample-effects')).toBeVisible();
    for (const id of PAGES.slice(1)) await expect(page.getByTestId(`ppage-sample-${id}`)).toBeHidden();
    await expect(page.getByTestId('mic-fx-reverse')).toBeVisible();
  });

  test('a tab shows its page and the waveform stays in view (REQ-the-tools-are-tabs)', async ({ page }) => {
    await openEditor(page);
    const dialog = page.getByRole('dialog', { name: 'Edit sample' });
    const wave = dialog.locator('canvas').first();

    for (const id of PAGES) {
      await page.getByTestId(`ptab-sample-${id}`).click();
      await expect(page.getByTestId(`ppage-sample-${id}`)).toBeVisible();
      for (const other of PAGES.filter((p) => p !== id)) {
        await expect(page.getByTestId(`ppage-sample-${other}`)).toBeHidden();
      }
      await expect(wave).toBeInViewport();
    }

    // Fit and Shift share a page (time-stretch.md REQ-fit-and-shift-share-a-tab).
    await page.getByTestId('ptab-sample-stretch').click();
    await expect(page.getByTestId('fit-row')).toBeVisible();
    await expect(page.getByTestId('shift-row')).toBeVisible();
  });

  test('the studio fills the screen (REQ-the-studio-fills-the-screen)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openEditor(page);
    const box = (await page.getByRole('dialog', { name: 'Edit sample' }).boundingBox())!;
    expect(box.width).toBeGreaterThan(1280 * 0.9);
    expect(box.height).toBeGreaterThan(900 * 0.9);
    // The footer's primary action is in view without scrolling.
    await expect(page.getByTestId('mic-load')).toBeInViewport();
  });

  // Regression: the screen scrolls vertically, and CSS turns the other axis into
  // `auto` with it — so the right crop handle, which hangs half outside the
  // waveform, made a 6px sideways scroll at every width. Playwright hides
  // scrollbars, so this reads the overflow, not the bar.
  test('the edit screen never scrolls sideways (REQ-the-studio-fills-the-screen)', async ({ page }) => {
    await openEditor(page);
    const screen = page.getByTestId('rec-screen-edit');
    for (const width of [900, 1400]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => screen.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    }
  });
});
