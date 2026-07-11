import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busSet } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const slotBufferLength = (page: Page, slot: number): Promise<number | null> =>
  page.evaluate((s) => {
    const b = (window as any).__synth.engine.sampler.buffers[s];
    return b ? (b.length as number) : null;
  }, slot);
const slotBufferPeak = (page: Page, slot: number): Promise<number> =>
  page.evaluate((s) => {
    const b = (window as any).__synth.engine.sampler.buffers[s];
    if (!b) return 0;
    const d = b.getChannelData(0) as Float32Array;
    let p = 0;
    for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
    return p;
  }, slot);
const sampleName = (page: Page, slot: number): Promise<string | null> =>
  page.evaluate((s) => (window as any).__synth.patterns.sampleNames[s], slot);
const contextSampleRate = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.ctx.sampleRate);

/**
 * Render-to-sampler (render-to-sampler.md): the Sequencer tab's "Import into
 * sampler" section resamples the edit bank through the live engine into a
 * bar-exact buffer. The length assertion is the feature's headline REQ-1 —
 * exactly round(240 / bpm × sampleRate) samples, verified against a real
 * audio graph.
 */
test.describe('import into sampler', () => {
  test('render is disabled while the bank is empty', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    await expect(page.getByTestId('seq-import-render')).toBeDisabled();
  });

  test('renders the bank into the chosen slot, bar-exact', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();

    // A two-note bank + a fast tempo so the 2-bar real-time render stays ~2 s.
    await page.getByTestId('seq-step-0').click();
    await page.getByTestId('seq-step-4').click();
    await busSet(page, 'transport.bpm', 240);

    // Pick slot S3 from the dropdown (options are "S3 — empty" style).
    await page.getByTestId('seq-import-slot').click();
    await page.getByRole('button', { name: 'S3 — empty' }).click();

    const renderBtn = page.getByTestId('seq-import-render');
    await expect(renderBtn).toBeEnabled();
    await renderBtn.click();
    await expect(renderBtn).toBeDisabled(); // busy while capturing

    // The render runs in real time (2 bars + tail) — poll for the buffer.
    await expect.poll(() => slotBufferLength(page, 2), { timeout: 15000 }).not.toBeNull();

    // REQ-1: exactly one bar. 240 BPM → 1 s → sampleRate samples.
    const sr = await contextSampleRate(page);
    expect(await slotBufferLength(page, 2)).toBe(Math.round((240 / 240) * sr));

    // The capture is real synth audio, not silence.
    expect(await slotBufferPeak(page, 2)).toBeGreaterThan(0.001);

    // REQ-7: derived slot name; the button is usable again.
    expect(await sampleName(page, 2)).toBe('seq-A-240bpm');
    await expect(renderBtn).toBeEnabled();
  });
});
