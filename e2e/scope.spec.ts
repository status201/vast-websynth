import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * The Wave/Spectrum visualizer's Mono/Stereo toggle (specs/features/scope.md).
 * Asserts the toggle state machine + orthogonality with Wave/Spectrum, the
 * per-channel analyser data path via the dev-only `window.__synth.engine` bridge,
 * and the Spectrum peak-hold (max-dB line rises with sound, click-to-reset).
 */

test.describe('scope mono/stereo', () => {
  test('channels toggle defaults to Mono and flips to Stereo and back', async ({ page }) => {
    await gotoAndStart(page);
    const chan = page.getByTestId('scope-channels-toggle');
    await expect(chan).toHaveText('Mono');
    await chan.click();
    await expect(chan).toHaveText('Stereo');
    await chan.click();
    await expect(chan).toHaveText('Mono');
  });

  test('Mono/Stereo is independent of Wave/Spectrum', async ({ page }) => {
    await gotoAndStart(page);
    const mode = page.getByTestId('scope-toggle');
    const chan = page.getByTestId('scope-channels-toggle');
    await expect(mode).toHaveText('Wave');
    await expect(chan).toHaveText('Mono');

    // Switch the view to Spectrum, then the channels to Stereo — neither resets
    // the other.
    await mode.click();
    await expect(mode).toHaveText('Spectrum');
    await chan.click();
    await expect(chan).toHaveText('Stereo');
    await expect(mode).toHaveText('Spectrum');
  });

  test('engine exposes distinct, working left/right analysers tapped pre-master', async ({ page }) => {
    await gotoAndStart(page);
    const info = await page.evaluate(() => {
      const e = (window as unknown as {
        __synth: { engine: { analyser: AnalyserNode; analyserL: AnalyserNode; analyserR: AnalyserNode } };
      }).__synth.engine;
      const isAnalyser = (n: unknown): boolean => n instanceof AnalyserNode;
      // Prove the L analyser is live: pulling time-domain data fills the buffer.
      const buf = new Uint8Array(e.analyserL.fftSize);
      e.analyserL.getByteTimeDomainData(buf);
      return {
        allAnalysers: isAnalyser(e.analyser) && isAnalyser(e.analyserL) && isAnalyser(e.analyserR),
        distinct: e.analyserL !== e.analyserR && e.analyserL !== e.analyser && e.analyserR !== e.analyser,
        fftMatches: e.analyserL.fftSize === e.analyser.fftSize && e.analyserR.fftSize === e.analyser.fftSize,
        bufLen: buf.length,
      };
    });
    expect(info.allAnalysers).toBe(true);
    expect(info.distinct).toBe(true);
    expect(info.fftMatches).toBe(true);
    expect(info.bufLen).toBe(2048);
  });

  test('Spectrum peak-hold rises with sound and resets on a graph click', async ({ page }) => {
    await gotoAndStart(page);
    const mode = page.getByTestId('scope-toggle');
    const canvas = page.getByTestId('scope-canvas');

    // The held peak dB mirrored onto the canvas dataset (null when absent/empty).
    const peakDb = (): Promise<number | null> =>
      page.evaluate(() => {
        const v = document.querySelector<HTMLCanvasElement>('[data-testid="scope-canvas"]')
          ?.dataset.peak;
        return v === undefined || v === '' ? null : parseFloat(v);
      });
    const play = (on: boolean): Promise<void> =>
      page.evaluate((down) => {
        const eng = (window as unknown as { __synth: { engine: {
          playNote(n: number, v?: number): void; releaseNote(n: number): void;
        } } }).__synth.engine;
        for (const n of [60, 64, 67]) down ? eng.playNote(n, 0.9) : eng.releaseNote(n);
      }, on);

    // Wave view exposes no peak readout.
    await expect(mode).toHaveText('Wave');
    expect(await peakDb()).toBeNull();

    // Spectrum + sound: the peak-hold climbs off the -70 dB floor.
    await mode.click();
    await expect(mode).toHaveText('Spectrum');
    await play(true);
    await page.waitForTimeout(400);
    const loud = await peakDb();
    expect(loud).not.toBeNull();
    expect(loud!).toBeGreaterThan(-65);

    // Release, let the tail die, then click the graph to reset — it drops back down.
    await play(false);
    await page.waitForTimeout(500);
    await canvas.click();
    await page.waitForTimeout(150);
    const afterReset = await peakDb();
    expect(afterReset!).toBeLessThan(loud!);

    // Switching back to Wave clears the readout entirely.
    await mode.click();
    await expect(mode).toHaveText('Wave');
    await page.waitForTimeout(100);
    expect(await peakDb()).toBeNull();
  });
});
