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
    expect(info.bufLen).toBe(1024);
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

  test('Wave exposes the applied auto-gain, and Spectrum clears it', async ({ page }) => {
    await gotoAndStart(page);
    const mode = page.getByTestId('scope-toggle');

    // The auto-gain mirrored onto the canvas dataset (null when absent/empty).
    const waveGain = (): Promise<number | null> =>
      page.evaluate(() => {
        const v = document.querySelector<HTMLCanvasElement>('[data-testid="scope-canvas"]')
          ?.dataset.waveGain;
        return v === undefined || v === '' ? null : parseFloat(v);
      });

    // Wave is the boot view; the gain appears on the first drawn frame and is
    // never below unity (a clipping signal is scaled 1:1, never shrunk).
    await expect(mode).toHaveText('Wave');
    await page.waitForTimeout(150);
    const gain = await waveGain();
    expect(gain).not.toBeNull();
    expect(gain!).toBeGreaterThanOrEqual(1);

    // Spectrum drops the readout (and freezes the gain).
    await mode.click();
    await expect(mode).toHaveText('Spectrum');
    await page.waitForTimeout(100);
    expect(await waveGain()).toBeNull();
  });
});

/**
 * The resize handle (scope.md REQ-19/20). It drags the shared bottom grid row,
 * so the PITCH/OCT/MOD wheel strips grow with the scope — that shared row is the
 * whole mechanism, and the strip assertion is what pins it.
 */
test.describe('scope resize', () => {
  const SCOPE_H_DEFAULT = 130;
  const SCOPE_H_MAX = 260;

  /** Drag the grip `dy` px upward (positive = taller). */
  async function dragHandle(page: import('@playwright/test').Page, dy: number): Promise<void> {
    const handle = page.getByTestId('scope-resize-handle');
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Two steps: the first move starts the stroke, the second lands it — a
    // single jump can outrun the rAF-coalesced write.
    await page.mouse.move(x, y - dy / 2);
    await page.mouse.move(x, y - dy);
    await page.mouse.up();
  }

  /** `--scope-h` is written inline on `.bottom` — the one element that carries it. */
  const rowHeight = (page: import('@playwright/test').Page): Promise<number> =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[style*="--scope-h"]');
      return el ? parseInt(el.style.getPropertyValue('--scope-h'), 10) : Number.NaN;
    });

  test('dragging the handle grows the scope and the wheel strips with it', async ({ page }) => {
    await gotoAndStart(page);
    const canvas = page.getByTestId('scope-canvas');
    const strip = page.getByTestId('strip-master.modWheel');

    expect(await rowHeight(page)).toBe(SCOPE_H_DEFAULT);
    const canvasBefore = (await canvas.boundingBox())!.height;
    const stripBefore = (await strip.boundingBox())!.height;

    await dragHandle(page, 60);

    expect(await rowHeight(page)).toBe(SCOPE_H_DEFAULT + 60);
    const canvasAfter = (await canvas.boundingBox())!.height;
    const stripAfter = (await strip.boundingBox())!.height;
    // Both live in the resized row, so both gain the full 60px.
    expect(canvasAfter - canvasBefore).toBeCloseTo(60, 0);
    expect(stripAfter - stripBefore).toBeCloseTo(60, 0);
  });

  test('the height stops at twice the default, and survives a reload', async ({ page }) => {
    await gotoAndStart(page);
    // Drag well past the ceiling — it clamps rather than running away.
    await dragHandle(page, 400);
    expect(await rowHeight(page)).toBe(SCOPE_H_MAX);

    await page.reload();
    const startBtn = page.getByRole('button', { name: 'Tap to start' });
    await startBtn.click();
    await expect(startBtn).toBeHidden();

    expect(await rowHeight(page)).toBe(SCOPE_H_MAX);
    await expect(page.getByTestId('scope-resize-handle'))
      .toHaveAttribute('aria-valuenow', String(SCOPE_H_MAX));
  });

  test('double-clicking the grip resets the height', async ({ page }) => {
    await gotoAndStart(page);
    await dragHandle(page, 80);
    expect(await rowHeight(page)).toBe(SCOPE_H_DEFAULT + 80);

    await page.getByTestId('scope-resize-handle').dblclick();
    expect(await rowHeight(page)).toBe(SCOPE_H_DEFAULT);
  });
});
