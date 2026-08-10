import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * The KEY tab and the sequencer's chord tools end to end
 * (scale-quantization.md, chord-tools.md).
 *
 * The point of these three is that the feature is *reachable* and that the two
 * destructive editor actions land in the store — the pitch maths itself is unit
 * tested, and whether the result is musical is a listening job (ADR-010).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((p) => (window as any).__synth.bus.get(p) as number, id);
const seqNote = (page: import('@playwright/test').Page, track: number, step: number) =>
  page.evaluate(
    ([t, s]) => (window as any).__synth.patterns.seqTrack(t)[s].note as number,
    [track, step],
  );

/** Pick a labelled option out of one of the KEY tab's dropdowns. */
async function choose(
  page: import('@playwright/test').Page, testid: string, label: string,
): Promise<void> {
  const dd = page.getByTestId(testid);
  await dd.click();
  await dd.getByRole('button', { name: label, exact: true }).click();
}

test.describe('key & chord tools', () => {
  test('choosing a scale lights the tab lamp and quantizes playback', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-key').click();
    expect(await get(page, 'scale.type')).toBe(0); // chromatic by default

    await expect(page.getByTestId('tab-key')).toHaveAttribute('aria-label', 'Key — off');
    await choose(page, 'key-scale', 'major');
    expect(await get(page, 'scale.type')).toBeGreaterThan(0);
    // machine-status.md REQ-10 — readable without opening the tab.
    await expect(page.getByTestId('tab-key')).toHaveAttribute('aria-label', 'Key — on');
  });

  test('the map paints four visually distinct states', async ({ page }) => {
    // The unit tests pin the roles; this pins that the CSS actually resolves them to
    // four different colours — the half a jsdom test cannot see.
    await gotoAndStart(page);
    await page.getByTestId('tab-key').click();
    await choose(page, 'key-scale', 'major');
    await choose(page, 'key-chord', 'triad');
    // `.white` carries a 120ms transition, so let it settle before reading colours.
    await page.waitForTimeout(400);

    const bg = (semi: number) => page.getByTestId(`key-map-${semi}`)
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const [root, chord, scale, out] = await Promise.all([bg(0), bg(4), bg(2), bg(1)]);
    expect(new Set([root, chord, scale, out]).size).toBe(4);
  });

  test('both info badges resolve their anchors and open (onboarding REQ-20)', async ({ page }) => {
    // The unit test pins the copy; only this pins that the anchors actually resolve —
    // a typo'd testid in ANCHORS silently drops the badge and nothing else notices.
    await gotoAndStart(page);
    await page.getByTestId('info-badges').click();

    const keyBadge = page.getByTestId('info-badge-key');
    await expect(keyBadge).toBeVisible();
    await keyBadge.click();
    await expect(page.locator('.modal, [role="dialog"]').first()).toContainText('never rewritten');
    await page.keyboard.press('Escape');

    await page.getByTestId('tab-seq').click();
    const chordBadge = page.getByTestId('info-badge-seq.chord');
    await expect(chordBadge).toBeVisible();
    await chordBadge.click();
    await expect(page.locator('.modal, [role="dialog"]').first()).toContainText('Undo');
  });

  test('chord memory is blocked until a scale is chosen', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-key').click();

    const chord = page.getByTestId('key-chord');
    await chord.click();
    await expect(chord.getByRole('button', { name: 'triad', exact: true })).toBeDisabled();
    await expect(page.getByTestId('key-hint')).toContainText('Chromatic');
  });

  test('SNAP rewrites the bank into the scale and one undo restores it', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-key').click();
    await choose(page, 'key-scale', 'major');

    await page.getByTestId('tab-seq').click();
    // Put a deliberately out-of-key note on track 1 step 0.
    await page.evaluate(() =>
      (window as any).__synth.patterns.setSeqStep(0, 0, { on: true, note: 61 }));
    expect(await seqNote(page, 0, 0)).toBe(61);

    await page.getByTestId('seq-snap').click();
    await expect(page.getByTestId('seq-snap-toast')).toBeVisible();
    expect(await seqNote(page, 0, 0)).toBe(60); // C# -> C

    await page.getByTestId('undo-seq').click();
    expect(await seqNote(page, 0, 0)).toBe(61);
  });
});
