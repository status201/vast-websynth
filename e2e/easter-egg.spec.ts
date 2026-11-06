import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * The Rickroll easter egg (specs/features/rickroll-easter-egg.md): the hook typed
 * on the real QWERTY note keys reaches the egg through the bus and raises the
 * offer. "Play it" is deliberately not clicked: it fetches a multi-MB zip, and
 * what it does after the click is pinned in tests/ui/easter-egg.test.ts.
 */

// The hook in C on the lower note row: C D F D A A G = Z X V X N N B
// (shortcuts.ts NOTE_ROWS), same intervals as the record's A♭ B♭ D♭ B♭ F F E♭.
const HOOK_KEYS = ['KeyZ', 'KeyX', 'KeyV', 'KeyX', 'KeyN', 'KeyN', 'KeyB'];

test('typing the hook on the QWERTY keys offers the song and loads nothing', async ({ page }) => {
  await gotoAndStart(page);
  await page.locator('body').click({ position: { x: 1, y: 1 } }); // no control holds the keys

  for (const key of HOOK_KEYS) {
    await page.keyboard.press(key, { delay: 60 });
    await page.waitForTimeout(120);
  }

  const offer = page.getByTestId('easter-egg-toast');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('Never gonna give you up');
  await expect(offer.getByTestId('toast-action')).toHaveText('Play it');
  // An offer, not a load: no Undo toast, transport untouched.
  await expect(page.getByTestId('song-undo-toast')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__synth.engine.clock.playing as boolean)).toBe(false);
});
