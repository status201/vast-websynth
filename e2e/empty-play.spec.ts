import { test, expect, type Page } from '@playwright/test';
import { sessionDisplay } from './helpers';

/**
 * The empty-play hint (specs/features/empty-play-hint.md): pressing Play with
 * nothing loaded shows an explanatory modal instead of a silent transport.
 * gotoAndStart seeds the opt-out flag for every other spec, so this spec
 * boots on its own (onboarding/perf pins only) — the flag starts absent and
 * is only ever written by the modal's checkbox, which makes the reload test
 * a genuine persistence check.
 */

async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', 'off');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  const startBtn = page.getByRole('button', { name: 'Tap to start' });
  await startBtn.click();
  await expect(startBtn).toBeHidden();
}

const playing = (page: Page) =>
  page.evaluate(() => (window as any).__synth.engine.clock.playing as boolean);

test.describe('empty-play hint', () => {
  test('Play on an empty boot shows the modal; Play a demo starts sound', async ({ page }) => {
    await boot(page);

    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('empty-play-modal')).toBeVisible();
    expect(await playing(page)).toBe(false); // the start was intercepted

    // Close leaves the transport stopped and the hint re-armed.
    await page.getByTestId('empty-play-close').click();
    await expect(page.getByTestId('empty-play-modal')).toHaveCount(0);
    expect(await playing(page)).toBe(false);
    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('empty-play-modal')).toBeVisible();

    // "Play a demo" applies a demo song and starts the transport in one go.
    await page.getByTestId('empty-play-demo').click();
    await expect.poll(() => playing(page)).toBe(true);
    expect(await sessionDisplay(page)).not.toBe('basic');
    await page.getByTestId('transport-play').click(); // stop
  });

  test('the opt-out checkbox survives a reload', async ({ page }) => {
    await boot(page);

    await page.getByTestId('transport-play').click();
    await page.getByTestId('empty-play-dismiss').check();
    await page.getByTestId('empty-play-close').click();

    // Same session: Play now starts the (silent) transport, as asked.
    await page.getByTestId('transport-play').click();
    await expect.poll(() => playing(page)).toBe(true);
    await page.getByTestId('transport-play').click(); // stop

    // Across a reload the checkbox's localStorage flag still suppresses the
    // modal (nothing re-seeds it here — boot() never writes this key).
    await page.reload();
    const startBtn = page.getByRole('button', { name: 'Tap to start' });
    await startBtn.click();
    await expect(startBtn).toBeHidden();
    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('empty-play-modal')).toHaveCount(0);
    await expect.poll(() => playing(page)).toBe(true);
  });
});
