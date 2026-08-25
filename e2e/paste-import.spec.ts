import { test, expect } from '@playwright/test';
import { gotoAndStart, busGet, sessionDisplay } from './helpers';

/**
 * specs/features/paste-import.md — the paste door end to end. The payloads here
 * are shaped like real AI replies (fenced, with prose around them), which is the
 * whole reason the feature exists.
 */

const SONG = {
  format: 'websynth-song-author',
  version: 1,
  name: 'Pasted Loop',
  params: { 'transport.bpm': 137 },
  seq: [{ notes: ['A2', null, 'A2', null, 'C3', null, 'A2', null] }],
  drums: [{ kick: [0, 4, 8, 12], chat: [2, 6, 10, 14] }],
};

const BANK = {
  format: 'websynth-preset-bank',
  version: 1,
  name: 'pasted-bank',
  presets: {
    'Pasted Lead': { 'filter.cutoff': 88, 'filter.resonance': 1.1 },
    'Pasted Bass': { 'filter.cutoff': 52, 'filter.resonance': 2.2 },
  },
};

/** An agent's answer: prose, a fenced block, more prose. */
const asReply = (payload: unknown): string =>
  `Here you go!\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nWant it faster?`;

async function openSongTab(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('tab-song').click();
}

test('pasting a fenced AI reply loads the song', async ({ page }) => {
  await gotoAndStart(page);
  await openSongTab(page);

  await page.getByTestId('song-paste').click();
  await expect(page.getByTestId('paste-modal')).toBeVisible();

  await page.getByTestId('paste-input').fill(asReply(SONG));
  // The status line recognizes it before anything is applied.
  await expect(page.getByTestId('paste-status')).toContainText('Pasted Loop');
  const confirm = page.getByTestId('paste-confirm');
  await expect(confirm).toHaveText('Load song');
  await confirm.click();

  await expect(page.getByTestId('paste-modal')).toBeHidden();
  // The song went through the normal import path: params applied, name active,
  // and the load-undo toast offered.
  expect(await busGet(page, 'transport.bpm')).toBe(137);
  expect(await sessionDisplay(page)).toContain('Pasted Loop');
  await expect(page.getByTestId('song-undo-toast')).toBeVisible();
});

test('pasting a bank routes into the preset import review step', async ({ page }) => {
  await gotoAndStart(page);
  await openSongTab(page);

  await page.getByTestId('song-paste').click();
  await page.getByTestId('paste-input').fill(asReply(BANK));
  await expect(page.getByTestId('paste-status')).toContainText('2 sounds');

  const confirm = page.getByTestId('paste-confirm');
  await expect(confirm).toHaveText('Review 2 presets');
  await confirm.click();

  // Straight to the wizard's review step — not the file-picker home.
  const review = page.getByTestId('preset-import-review');
  await expect(review).toBeVisible();
  await expect(page.getByTestId('preset-import-row-Pasted Lead')).toBeVisible();
  await page.getByTestId('preset-import-confirm').click();

  // Imported sounds reach the header dropdown; the live patch is untouched.
  await expect(page.getByTestId('preset-select')).toContainText('Pasted Lead');
});

test('junk is refused with a reason and the confirm stays disabled', async ({ page }) => {
  await gotoAndStart(page);
  await openSongTab(page);

  await page.getByTestId('song-paste').click();
  await page.getByTestId('paste-input').fill('Sorry — I can only describe it in words.');
  await expect(page.getByTestId('paste-status')).toContainText('No JSON');
  await expect(page.getByTestId('paste-confirm')).toBeDisabled();
});

test('the AI Prompt modal embeds the same paste step', async ({ page }) => {
  await gotoAndStart(page);
  await openSongTab(page);

  // The sparkle is an aria-hidden drawing now, so the accessible name is the
  // words alone — which is the point (iconography.md REQ-3).
  await page.getByRole('button', { name: 'AI Prompt' }).click();
  await page.getByTestId('paste-input').fill(asReply(SONG));
  await page.getByTestId('paste-confirm').click();

  // A successful load closes the AI modal so the user sees what landed.
  await expect(page.getByTestId('paste-input')).toBeHidden();
  expect(await busGet(page, 'transport.bpm')).toBe(137);
});
