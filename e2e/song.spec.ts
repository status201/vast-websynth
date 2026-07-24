import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoAndStart, sessionDisplay, makeWavBuffer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const seqOn = (page: import('@playwright/test').Page, i: number): Promise<boolean> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[0][idx].on, i);

test.describe('song mode', () => {
  test('save → new → load round-trips pattern state via localStorage', async ({ page }) => {
    await gotoAndStart(page);

    // Make the pattern non-default.
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-step-5').click();
    expect(await seqOn(page, 5)).toBe(true);

    await page.getByTestId('tab-song').click();

    // Save names the song via the custom prompt dialog and also downloads a JSON copy.
    const jsonDownload = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await page.getByTestId('dialog-input').fill('e2e-song');
    await page.getByTestId('dialog-confirm').click();
    await jsonDownload; // consume the JSON download so it doesn't dangle
    const stored = await page.evaluate(() => localStorage.getItem('websynth.song.e2e-song'));
    expect(stored).not.toBeNull();

    // Wait for the Save dialog to fully detach (200ms fade) before opening New, so
    // the next getByTestId('dialog-confirm') isn't ambiguous between the two dialogs.
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

    // New clears all banks/chains (custom confirm dialog). The slot dropdown keeps
    // the saved name selected, so Load reloads it.
    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(() => seqOn(page, 5)).toBe(false);

    await page.getByTestId('song-load').click();
    await expect.poll(() => seqOn(page, 5)).toBe(true);
  });

  /**
   * song-mode.md REQ-3b / sampler.md REQ-7 (regression): a slot's audio belongs
   * to the name beside it. Loading a song that doesn't name slot 0 used to leave
   * the previous sample loaded and playable under the new song's label.
   */
  test('loading a song evicts sampler audio it does not name', async ({ page }) => {
    await gotoAndStart(page);

    // Save a song while every sampler slot is empty — its sampleNames are all null.
    await page.getByTestId('tab-song').click();
    const jsonDownload = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await page.getByTestId('dialog-input').fill('no-samples');
    await page.getByTestId('dialog-confirm').click();
    await jsonDownload;
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

    // Now load a clip into slot 0.
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();

    // Load the sample-less song back: the slot must come back empty, not keep
    // playing beep.wav under a blank label.
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-load').click();

    await page.getByTestId('tab-sampler').click();
    await expect(page.getByTestId('sampler-name-0')).toHaveText('S1 …');
    await expect(page.getByTestId('sampler-edit-0')).toBeHidden();
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const loaded = await page.evaluate(() => (window as any).__synth.engine.sampler.buffers[0] != null);
    expect(loaded).toBe(false);
  });

  test('per-lane Clear confirms before wiping the arrangement chain', async ({ page }) => {
    await gotoAndStart(page);
    const seqSteps = () =>
      page.evaluate(() => (window as any).__synth.engine.arrangement.seq.steps.length);

    // Build a multi-step chain so Clear has something to lose.
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0, 1, 2, 3], false));
    await page.getByTestId('tab-song').click();
    expect(await seqSteps()).toBe(4);

    // Cancelling the confirm leaves the chain intact.
    await page.getByTestId('chain-clear-seq').click();
    await page.getByTestId('dialog-cancel').click();
    // Wait for the dialog to fully detach (200ms fade) before re-opening, so the
    // next getByTestId('dialog-confirm') is unambiguous.
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    expect(await seqSteps()).toBe(4);

    // Confirming resets it to a single bank.
    await page.getByTestId('chain-clear-seq').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(seqSteps).toBe(1);
  });

  test('loading a demo labels the preset selector with the song name', async ({ page }) => {
    await gotoAndStart(page);
    expect(await sessionDisplay(page)).toBe('basic');

    // Stopped transport: the Play LED runs the idle attract pulse
    // (play-button-blink.md REQ-2).
    await expect(page.getByTestId('transport-play')).toHaveClass(/\battract\b/);

    await page.getByTestId('tab-song').click();
    // Only the first 6 demos are inline; Zombie Nation (a built-in, after the
    // drop-ins) hides behind the "All Demos" toggle (song-mode.md REQ-10).
    await expect(page.getByTestId('song-demo-Zombie Nation')).toBeHidden();
    await page.getByTestId('song-demo-more').click();
    await page.getByTestId('song-demo-Zombie Nation').click();

    await expect.poll(() => sessionDisplay(page)).toBe('Zombie Nation');
    await expect(page.getByTestId('preset-select')).toContainText('Zombie Nation');

    // The demo load arms the fast green "press play" cue while stopped
    // (play-button-blink.md REQ-3); starting the transport consumes it (REQ-4).
    await expect(page.getByTestId('transport-play')).toHaveClass(/\bcue\b/);
    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('transport-play')).not.toHaveClass(/\bcue\b/);
    await expect(page.getByTestId('transport-play')).not.toHaveClass(/\battract\b/);
    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('transport-play')).toHaveClass(/\battract\b/);

    // Any silent-while-stopped action re-arms the cue — here, enabling a
    // machine via the bus (play-button-blink.md REQ-3). The sampler is the
    // one machine this demo leaves off, so the set is a real 0 → 1 edge.
    await page.evaluate(() => (window as any).__synth.bus.set('sampler.on', 1));
    await expect(page.getByTestId('transport-play')).toHaveClass(/\bcue\b/);
  });

  test('Export Song renders and downloads a WAV', async ({ page }) => {
    await gotoAndStart(page);
    // Shorten the render to a single bar (default fallback is 4) via the bridge.
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0], true));

    await page.getByTestId('tab-song').click();
    // audio-export.md REQ-8: the label names the format it will write.
    await expect(page.getByTestId('song-export-audio')).toHaveText('Export Song as WAV');
    const wavDownload = page.waitForEvent('download', { timeout: 20000 });
    await page.getByTestId('song-export-audio').click();
    const download = await wavDownload;

    expect(download.suggestedFilename()).toMatch(/\.wav$/);
    const path = await download.path();
    const head = readFileSync(path);
    expect(head.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(head.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });

  // audio-export.md REQ-7: the MP3 encoder (lamejs) is a lazily-imported chunk,
  // so this is the only check that the dynamic import actually resolves in a
  // real browser. We inspect bytes rather than decode — CI Chromium has no MP3
  // decoder, but an MPEG frame sync is just a bit pattern.
  test('Export Song downloads an MP3 through the lazily-loaded encoder', async ({ page }) => {
    await gotoAndStart(page);
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0], true));

    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-export-fmt-mp3').click();
    await expect(page.getByTestId('song-export-audio')).toHaveText('Export Song as MP3');
    await expect(page.getByTestId('song-record')).toHaveText('Record as MP3');
    const mp3Download = page.waitForEvent('download', { timeout: 20000 });
    await page.getByTestId('song-export-audio').click();
    const download = await mp3Download;

    expect(download.suggestedFilename()).toMatch(/\.mp3$/);
    const bytes = readFileSync(await download.path());
    // First MPEG audio frame: 11 set sync bits, then the 192 kbps index (0xB).
    let i = 0;
    while (i < bytes.length - 4 && !(bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0)) i++;
    expect(i).toBeLessThan(bytes.length - 4);
    expect(bytes[i + 2]! >> 4).toBe(0xb);
  });
});
