import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet, busSet, clickDemo, dropInDeclaring, otherBpm } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const drumOn = (page: Page, t: number, s: number): Promise<boolean> =>
  page.evaluate(([tt, ss]) => (window as any).__synth.patterns.drum[tt!][ss!].on, [t, s]);

const autosaveRaw = (page: Page): Promise<string | null> =>
  page.evaluate(() => localStorage.getItem('websynth.session'));

test.describe('session safety net', () => {
  test('the working session autosaves and restores silently across a reload', async ({ page }) => {
    await gotoAndStart(page);

    // Edit a param (bus) and a pattern cell (store) — both autosave triggers.
    await busSet(page, 'filter.cutoff', 42);
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('drum-step-0-3').click();
    expect(await drumOn(page, 0, 3)).toBe(true);

    // The debounced (1.5 s) write lands in websynth.session.
    await expect.poll(() => autosaveRaw(page), { timeout: 5000 }).not.toBeNull();

    // Same context keeps localStorage: boot restores the session silently.
    await page.reload();
    await page.getByRole('button', { name: 'Tap to start' }).click();
    expect(await busGet(page, 'filter.cutoff')).toBe(42);
    expect(await drumOn(page, 0, 3)).toBe(true);
  });

  test('a demo click shows an Undo toast that restores the prior session', async ({ page }) => {
    await gotoAndStart(page);

    // A drop-in that states a tempo, so the assertions below come out of the
    // shipped file rather than a literal, and the user's edit is chosen to
    // differ from it — otherwise "whose BPM is this?" has no answer.
    const { demo, song } = dropInDeclaring(['transport.bpm']);
    const demoBpm = song.params['transport.bpm']!;
    const mine = otherBpm(demoBpm);

    await page.getByTestId('tab-drums').click();
    await page.getByTestId('drum-step-0-3').click();
    await busSet(page, 'transport.bpm', mine);

    await page.getByTestId('tab-song').click();
    await clickDemo(page, demo.name);

    // The demo replaced the session (its own drum bank, its own BPM)…
    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(demoBpm);
    expect(await drumOn(page, 0, 3)).toBe(false);
    const toast = page.getByTestId('song-undo-toast');
    await expect(toast).toBeVisible();
    // The toast quotes the loaded file's own name — the index proved again.
    await expect(toast).toContainText(demo.name);

    // …and Undo brings the user's work back.
    await page.getByTestId('toast-action').click();
    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(mine);
    expect(await drumOn(page, 0, 3)).toBe(true);
    await expect(toast).toHaveCount(0);
  });

  test('New keeps its confirm dialog, then offers Undo via the toast', async ({ page }) => {
    await gotoAndStart(page);

    await page.getByTestId('tab-drums').click();
    await page.getByTestId('drum-step-0-3').click();

    // New still confirms (danger dialog, song-mode.md) — cancel leaves state.
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    expect(await drumOn(page, 0, 3)).toBe(true);

    // Confirmed: the session clears and the toast offers the way back.
    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(() => drumOn(page, 0, 3)).toBe(false);
    await expect(page.getByTestId('song-undo-toast')).toBeVisible();
    await page.getByTestId('toast-action').click();
    await expect.poll(() => drumOn(page, 0, 3)).toBe(true);
  });
});
