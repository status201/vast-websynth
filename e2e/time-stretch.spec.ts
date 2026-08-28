import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const slotDuration = (page: Page, slot: number): Promise<number | null> =>
  page.evaluate((s) => (window as any).__synth.engine.sampler.buffers[s]?.duration ?? null, slot);
const slotName = (page: Page, slot: number): Promise<string | null> =>
  page.evaluate((s) => (window as any).__synth.patterns.sampleNames[s] ?? null, slot);

/** One bar in seconds, measured the way the transport measures it (meter.md REQ-7). */
const barSeconds = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const s = (window as any).__synth;
    return s.engine.barTicks * s.engine.clock.sixteenthDuration();
  });

/** Pick a Dropdown option by its `dropdown-option` bridge class, not by accessible
 *  name — the toggle and the option carry the same one (dropdown.md REQ-13). */
async function pick(page: Page, testId: string, label: RegExp): Promise<void> {
  const dd = page.getByTestId(testId);
  await dd.click();
  await dd.locator('.dropdown-option', { hasText: label }).click();
}

/**
 * Load a clip that is deliberately NOT a whole number of bars.
 *
 * 1.7 s against the default 120 BPM 4/4 bar of 2.0 s is the shape this feature is
 * for: close enough that the nearest musical length is one bar, far enough that a
 * no-op would pass a sloppy assertion.
 */
async function loadClip(page: Page, slot = 0, name = 'break.wav'): Promise<void> {
  await gotoAndStart(page);
  await page.getByTestId('tab-sampler').click();
  await page.getByTestId(`sampler-file-${slot}`).setInputFiles({
    name, mimeType: 'audio/wav', buffer: makeWavBuffer(1.7),
  });
  await expect(page.getByTestId(`sampler-name-${slot}`)).toHaveText(name);
}

/**
 * Open the editor on `slot` and unfold the Fit & Shift section, which rests closed
 * like every other editor section (sample-recorder.md REQ-9). The fold itself is
 * asserted by `sample-editor-folds.spec.ts`.
 */
async function openStretch(page: Page, slot = 0): Promise<void> {
  await page.getByTestId(`sampler-edit-${slot}`).click();
  const row = page.getByTestId('fit-row');
  if (!(await row.isVisible())) await page.getByTestId('stretch-toggle').click();
  await expect(row).toBeVisible();
}

/**
 * time-stretch.md — retiming a clip to a musical length with its pitch intact.
 *
 * The arithmetic and the DSP are unit-tested; what only end-to-end proves is that
 * the buffer the sampler ends up holding is the bar-exact one, that the one-click
 * path really is one click, and that taking it back restores the audio rather than
 * the name.
 */
test.describe('time-stretch', () => {
  test('fits a clip to one bar from the editor (REQ-9)', async ({ page }) => {
    await loadClip(page);
    const before = await slotDuration(page, 0);
    expect(before).toBeCloseTo(1.7, 2);

    await openStretch(page);

    // The row preselects the nearest target, which for a 1.7 s clip is 14
    // sixteenths — so picking one bar is a real choice, not the default.
    await pick(page, 'fit-target', /^16 · 1 bar$/);
    await expect(page.getByTestId('fit-hint')).toContainText('1.70 s → 2.00 s');

    await page.getByTestId('fit-apply').click();
    await expect(page.getByTestId('fit-hint')).toContainText('2.00 s → 2.00 s');

    await page.getByTestId('mic-load').click();

    const bar = await barSeconds(page);
    expect(await slotDuration(page, 0)).toBeCloseTo(bar, 3);
  });

  test('shifts pitch without moving the length (REQ-8)', async ({ page }) => {
    await loadClip(page);
    await openStretch(page);
    await expect(page.getByTestId('shift-row')).toBeVisible();

    // Disabled at 0 semitones, and it says why.
    await expect(page.getByTestId('shift-apply')).toBeDisabled();
    await pick(page, 'shift-amount', /^\+7 st$/);
    await expect(page.getByTestId('shift-apply')).toBeEnabled();

    await page.getByTestId('shift-apply').click();
    await page.getByTestId('mic-load').click();

    // Same length it went in with — the whole point of a shift over the slot's
    // varispeed PITCH knob.
    expect(await slotDuration(page, 0)).toBeCloseTo(1.7, 1);
  });

  test('quick-fits from the slot row and takes it back (REQ-11/REQ-12)', async ({ page }) => {
    await loadClip(page);
    const bar = await barSeconds(page);

    await page.getByTestId('sampler-fit-0').click();
    await expect(page.getByTestId('fit-toast')).toBeVisible();
    expect(await slotDuration(page, 0)).toBeCloseTo(bar, 3);
    // REQ-13 — same sound, new timing: the name must not have moved, or
    // sampler.md REQ-7 would evict the audio the fit just wrote.
    expect(await slotName(page, 0)).toBe('break.wav');

    await page.getByTestId('fit-toast').getByRole('button', { name: 'Undo' }).click();
    expect(await slotDuration(page, 0)).toBeCloseTo(1.7, 2);
    expect(await slotName(page, 0)).toBe('break.wav');
  });

  test('the FIT button appears only once a slot holds audio (REQ-11)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await expect(page.getByTestId('sampler-fit-0')).toBeHidden();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'break.wav', mimeType: 'audio/wav', buffer: makeWavBuffer(1.7),
    });
    await expect(page.getByTestId('sampler-fit-0')).toBeVisible();
    // It states the outcome it will produce, so the one-click action is not blind.
    await expect(page.getByTestId('sampler-fit-0')).toHaveAttribute('title', /Fit to 1 bar/);
  });
});
