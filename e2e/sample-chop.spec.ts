import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const slotName = (page: Page, slot: number): Promise<string | null> =>
  page.evaluate((s) => (window as any).__synth.patterns.sampleNames[s] ?? null, slot);
const slotLoaded = (page: Page, slot: number): Promise<boolean> =>
  page.evaluate((s) => (window as any).__synth.engine.sampler.buffers[s] != null, slot);

/** Pick a Dropdown option by its `dropdown-option` bridge class, not by accessible
 *  name — the toggle and the option carry the same one (dropdown.md REQ-13). */
async function pick(page: Page, testId: string, label: RegExp): Promise<void> {
  const dd = page.getByTestId(testId);
  await dd.click();
  await dd.locator('.dropdown-option', { hasText: label }).click();
}

/** Load a clip into `slot` and open it in the editor via the ✎ button. */
async function openEditor(page: Page, slot: number, name = 'break.wav'): Promise<void> {
  await gotoAndStart(page);
  await page.getByTestId('tab-sampler').click();
  await page.getByTestId(`sampler-file-${slot}`).setInputFiles({
    name, mimeType: 'audio/wav', buffer: makeWavBuffer(2.0),
  });
  await expect(page.getByTestId(`sampler-name-${slot}`)).toHaveText(name);
  await page.getByTestId(`sampler-edit-${slot}`).click();
  await expect(page.getByTestId('chop-row')).toBeVisible();
}

/**
 * sample-chop.md — chopping a break into slices and spreading them across slots.
 *
 * The value of these is the *placement*: the slice maths is unit-tested, but that
 * the right audio lands in the right slot under the right name, and that a spread
 * can be taken back, is only true end to end.
 */
test.describe('sample chop', () => {
  test('chops the selection into slices and spreads them across slots', async ({ page }) => {
    await openEditor(page, 0);

    await page.getByTestId('chop-equal').click();
    await expect(page.getByTestId('chop-row')).toContainText('4 slices → S1–S4');

    await page.getByTestId('chop-spread').click();
    await page.getByTestId('dialog-confirm').click();

    for (let s = 0; s < 4; s++) {
      expect(await slotName(page, s)).toBe(`break ${s + 1}/4`);
      expect(await slotLoaded(page, s)).toBe(true);
    }
    // The spread stops where it was told to: slot 5 is untouched.
    expect(await slotName(page, 4)).toBeNull();
  });

  test('Spread is unavailable until the selection has been cut (REQ-6)', async ({ page }) => {
    await openEditor(page, 0);
    await expect(page.getByTestId('chop-spread')).toBeDisabled();
    await page.getByTestId('chop-equal').click();
    await expect(page.getByTestId('chop-spread')).toBeEnabled();
  });

  test('offers only the slice counts that fit from the chosen slot (REQ-5)', async ({ page }) => {
    await openEditor(page, 0);

    // S7 is the seventh slot, so two slices fit below it and eight do not.
    await pick(page, 'mic-slot-select', /^S7 —/);
    const counts = page.getByTestId('chop-count');
    await counts.click();
    await expect(counts.locator('.dropdown-option', { hasText: /^2 slices$/ })).toBeVisible();
    await expect(counts.locator('.dropdown-option', { hasText: /^8 slices$/ })).toHaveCount(0);
    await counts.click(); // close it again

    // The last slot has no room at all, and says so rather than offering nothing.
    await pick(page, 'mic-slot-select', /^S8 —/);
    await expect(page.getByTestId('chop-row')).toContainText('no room below S8');
    await expect(page.getByTestId('chop-equal')).toBeDisabled();
  });

  /**
   * REQ-5, regression. The count list is filtered when the chop is MADE, which
   * says nothing about moving the picker afterwards. Before the fix the label
   * went on promising four slices — naming "S9", a slot that does not exist —
   * while Spread stayed enabled and quietly wrote three.
   */
  test('a chop that no longer fits refuses instead of dropping slices (REQ-5)', async ({ page }) => {
    await openEditor(page, 0);
    await page.getByTestId('chop-equal').click();
    await expect(page.getByTestId('chop-row')).toContainText('4 slices → S1–S4');

    // Four slices need four slots; S6 leaves three.
    await pick(page, 'mic-slot-select', /^S6 —/);
    await expect(page.getByTestId('chop-row')).toContainText('4 slices need 4 slots');
    await expect(page.getByTestId('chop-row')).not.toContainText('S9');
    await expect(page.getByTestId('chop-spread')).toBeDisabled();

    // Moving back to where they fit re-enables it, unchanged.
    await pick(page, 'mic-slot-select', /^S4 —/);
    await expect(page.getByTestId('chop-row')).toContainText('4 slices → S4–S7');
    await expect(page.getByTestId('chop-spread')).toBeEnabled();

    await page.getByTestId('chop-spread').click();
    await page.getByTestId('dialog-confirm').click();
    // All four landed — none was dropped off the end.
    for (let k = 0; k < 4; k++) {
      expect(await slotName(page, 3 + k)).toBe(`break ${k + 1}/4`);
    }
  });

  test('a spread is confirmed first, and cancelling changes nothing (REQ-6)', async ({ page }) => {
    await openEditor(page, 0);
    await page.getByTestId('chop-equal').click();
    await page.getByTestId('chop-spread').click();
    await page.getByTestId('dialog-cancel').click();

    // Still the whole file under its own name, and the editor is still open.
    expect(await slotName(page, 0)).toBe('break.wav');
    expect(await slotName(page, 1)).toBeNull();
    await expect(page.getByTestId('chop-row')).toBeVisible();
  });

  test('Undo restores every overwritten slot, audio and name together (REQ-6)', async ({ page }) => {
    await openEditor(page, 0);
    // Slot 1 holds something else, so the spread has real work to take back.
    await page.getByTestId('mic-close').click();
    await page.getByTestId('sampler-file-1').setInputFiles({
      name: 'keeper.wav', mimeType: 'audio/wav', buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-1')).toHaveText('keeper.wav');

    await page.getByTestId('sampler-edit-0').click();
    await page.getByTestId('chop-equal').click();
    await page.getByTestId('chop-spread').click();
    await page.getByTestId('dialog-confirm').click();
    expect(await slotName(page, 1)).toBe('break 2/4');

    await page.getByTestId('chop-toast').getByTestId('toast-action').click();
    expect(await slotName(page, 0)).toBe('break.wav');
    expect(await slotName(page, 1)).toBe('keeper.wav');
    expect(await slotLoaded(page, 1)).toBe(true);
    // Slots the spread created, and that held nothing before, go back to empty.
    expect(await slotName(page, 3)).toBeNull();
    expect(await slotLoaded(page, 3)).toBe(false);
  });

  test('an edit drops stale boundaries rather than cutting the wrong audio', async ({ page }) => {
    await openEditor(page, 0);
    await page.getByTestId('chop-equal').click();
    await expect(page.getByTestId('chop-spread')).toBeEnabled();

    // Reverse re-bases every sample index the boundaries were expressed in.
    await page.getByTestId('mic-fx-reverse').click();
    await expect(page.getByTestId('chop-spread')).toBeDisabled();
    await expect(page.getByTestId('chop-row')).toContainText('cut the selection');
  });
});
