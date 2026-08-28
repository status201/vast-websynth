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
 *  name — the toggle and the option carry the same one. */
async function pick(page: Page, testId: string, label: RegExp): Promise<void> {
  const dd = page.getByTestId(testId);
  await dd.click();
  await dd.locator('.dropdown-option', { hasText: label }).click();
}

async function loadClip(page: Page, slot = 0, name = 'break.wav'): Promise<void> {
  await gotoAndStart(page);
  await page.getByTestId('tab-sampler').click();
  await page.getByTestId(`sampler-file-${slot}`).setInputFiles({
    name, mimeType: 'audio/wav', buffer: makeWavBuffer(1.7),
  });
  await expect(page.getByTestId(`sampler-name-${slot}`)).toHaveText(name);
}

/** Open the editor and unfold the scratch section, which starts collapsed. */
async function openScratch(page: Page, slot = 0): Promise<void> {
  await page.getByTestId(`sampler-edit-${slot}`).click();
  await expect(page.getByTestId('scratch-section')).toBeVisible();
  const body = page.getByTestId('scratch-body');
  if (!(await body.isVisible())) await page.getByTestId('scratch-toggle').click();
  await expect(body).toBeVisible();
}

/**
 * scratch.md — drawing a turntable gesture over a clip and printing it in.
 *
 * The curve arithmetic and the reader are unit-tested; what only end-to-end
 * proves is that the buffer the sampler ends up holding is the bar-exact one,
 * that the section is reachable from the slot row, and that Undo gives back the
 * audio rather than the name.
 */
test.describe('scratch', () => {
  test('prints a bar-exact scratch into the clip (REQ-5, REQ-15)', async ({ page }) => {
    await loadClip(page);
    expect(await slotDuration(page, 0)).toBeCloseTo(1.7, 2);

    await openScratch(page);
    await expect(page.getByTestId('scratch-canvas')).toBeVisible();

    // The row preselects the length nearest the clip, which for 1.7 s at 120 BPM
    // is 14 sixteenths — so asking for one bar is a real choice, not the default.
    await pick(page, 'scratch-length', /^16 · 1 bar$/);
    await pick(page, 'scratch-preset', /^Baby/);
    await page.getByTestId('scratch-apply').click();

    await page.getByTestId('mic-load').click();
    const bar = await barSeconds(page);
    // One frame of tolerance: the target is round(steps x sixteenth x sampleRate).
    expect(await slotDuration(page, 0)).toBeCloseTo(bar, 3);
  });

  test('undo restores the audio and never the name (REQ-21, REQ-22)', async ({ page }) => {
    await loadClip(page);
    await openScratch(page);
    await pick(page, 'scratch-length', /^8 · ½ bar$/);
    await page.getByTestId('scratch-apply').click();
    await page.getByTestId('mic-undo').click();
    await page.getByTestId('mic-load').click();

    expect(await slotDuration(page, 0)).toBeCloseTo(1.7, 2);
    // sampler.md REQ-7 evicts a slot's buffer on rename, so a scratched clip that
    // was renamed would lose the audio this just wrote.
    expect(await slotName(page, 0)).toBe('break.wav');
  });

  test('rolling the dice changes the shape without applying it (REQ-19)', async ({ page }) => {
    await loadClip(page);
    await openScratch(page);
    const legend = page.getByTestId('scratch-legend');
    const before = await legend.textContent();
    for (let i = 0; i < 6 && (await legend.textContent()) === before; i++) {
      await page.getByTestId('scratch-random').click();
    }
    expect(await legend.textContent()).not.toBe(before);
    // Rolling is not applying: the slot still holds what it held.
    await page.getByTestId('mic-close').click();
    expect(await slotDuration(page, 0)).toBeCloseTo(1.7, 2);
  });

  test('preview commits nothing (REQ-23)', async ({ page }) => {
    await loadClip(page);
    await openScratch(page);
    await page.getByTestId('scratch-preview').click();
    await page.getByTestId('mic-load').click();
    expect(await slotDuration(page, 0)).toBeCloseTo(1.7, 2);
  });

  test('the section starts folded away (REQ-15)', async ({ page }) => {
    await loadClip(page);
    await page.getByTestId('sampler-edit-0').click();
    await expect(page.getByTestId('scratch-section')).toBeVisible();
    await expect(page.getByTestId('scratch-body')).toBeHidden();
  });
});
