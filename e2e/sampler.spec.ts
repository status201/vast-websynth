import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const slotLoaded = (page: Page, slot: number): Promise<boolean> =>
  page.evaluate((s) => (window as any).__synth.engine.sampler.buffers[s] != null, slot);

/**
 * Loading a WAV via the hidden file input decodes it (decodeAudioData), fills
 * the slot's AudioBuffer, updates the filename label, and reveals the ✎ edit
 * button (hidden until a buffer is present).
 */
test.describe('sampler', () => {
  test('loading a WAV file fills the slot', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await expect(page.getByTestId('sampler-edit-0')).toBeHidden();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });

    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();

    expect(await slotLoaded(page, 0)).toBe(true);
  });

  /**
   * sample-persistence.md — the clip itself (not just its name) is persisted in
   * IndexedDB, so a reload brings the audio back with no `.needs-reload` hint
   * and nothing to re-pick from disk.
   */
  test('a loaded clip survives a reload', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');

    // The session autosave (1.5 s) carries the NAME; the clip store (0.8 s)
    // carries the audio. Both must have landed before the reload.
    await expect
      .poll(
        () =>
          // Per-tab key since v8 (session-autosave.md REQ-12) — scan, don't name.
          page.evaluate(
            () => Object.keys(localStorage).find((k) => k.startsWith('websynth.session.')) ?? null,
          ),
        { timeout: 5000 },
      )
      .not.toBeNull();

    // Same context ⇒ localStorage and IndexedDB both survive.
    await page.reload();
    await page.getByRole('button', { name: 'Tap to start' }).click();
    await page.getByTestId('tab-sampler').click();

    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-name-0')).not.toHaveClass(/needs-reload/);
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();
    expect(await slotLoaded(page, 0)).toBe(true);
    // …and the user is told the audio came from storage, not the song file.
    await expect(page.getByTestId('clips-restored-toast')).toContainText('1 sampler clip');
  });

  /**
   * sampler.md REQ-9 — the Clear ▾ row item is labelled with the FILENAME, so it
   * removes the file. Before v5 it cleared steps only, which left no gesture at
   * all that could empty a slot: the name stayed on screen and kept riding along
   * in every saved song. This drives the real panel, so it also pins that
   * `sampler-panel.ts` wires the eject row rather than the old step-only one.
   */
  test('Clear ▾ on a named slot ejects the sample, and Undo brings it back', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');

    // Slot 0 is the selected row on open, so the item is this slot's.
    await page.getByTestId('clear-sampler').click();
    const row = page.getByTestId('clear-sampler-row-0');
    await expect(row).toHaveText('Clear beep.wav'); // it names the file it takes
    await row.click();

    await expect(page.getByTestId('sampler-name-0')).toHaveText('S1 …'); // placeholder
    await expect(page.getByTestId('sampler-edit-0')).toBeHidden();
    expect(await slotLoaded(page, 0)).toBe(false);
    expect(await page.evaluate(() =>
      (window as any).__synth.patterns.sampleNames[0])).toBeNull();

    // Instantly reversible, which is what buys the no-confirmation rule
    // (step-grid-editing.md REQ-6): name and audio both return.
    await page.getByTestId('clear-toast-sampler').getByTestId('toast-action').click();
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-name-0')).not.toHaveClass(/needs-reload/);
    expect(await slotLoaded(page, 0)).toBe(true);
  });
});
