import { test, expect } from '@playwright/test';

/**
 * The start gate (audio-lifecycle.md REQ-19/REQ-20/REQ-21).
 *
 * "Tap to start" exists to buy a user gesture, so it is shown only where the
 * browser demands one. Which branch runs is decided from the state the
 * `AudioContext` was *created* in — a running one means the output stream is
 * already open, which is an observation about this browser, not a guess about
 * its policy.
 *
 * This is the only spec that asserts on the modal's presence: every other spec
 * goes through `startAudio()`, which takes whichever gate it is given.
 *
 * The permitted branch is simply what this suite gets — `playwright.config.ts`
 * launches with `--autoplay-policy=no-user-gesture-required`. The blocked
 * branch has to be **simulated**, because headless Chromium hands back a
 * running AudioContext under every value of that flag (measured: all three of
 * no-user-gesture-required / user-gesture-required /
 * document-user-activation-required give `state: 'running'`). Chrome's policy
 * is not ours to test; the branch that reads it is — so the second block stubs
 * the one thing the app actually looks at.
 */

/** The state reads go through the dev-only `window.__synth` bridge (main.ts). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const ctxState = (page: import('@playwright/test').Page): Promise<string> =>
  // `expect.poll` propagates a throw instead of retrying it, and the dev bridge
  // only exists once boot has got that far — so report the gap as a value.
  page.evaluate(() => ((window as any).__synth?.engine.ctx.state as string) ?? 'booting');

const autoplayAllowed = (page: import('@playwright/test').Page): Promise<boolean> =>
  page.evaluate(() => (window as any).__synth.engine.autoplayAllowed as boolean);

/** Suppress the first-visit tour so its overlay never intercepts these clicks. */
const quietBoot = (page: import('@playwright/test').Page): Promise<void> =>
  page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', 'off');
      localStorage.setItem('websynth.hint.emptyplay', '1');
    } catch {
      /* ignore */
    }
  });

const startBtn = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Tap to start' });

test.describe('autoplay permitted — no modal (REQ-20)', () => {
  test('starts itself, with audio running and no gesture', async ({ page }) => {
    await quietBoot(page);
    await page.goto('/');

    await expect.poll(() => ctxState(page)).toBe('running');
    expect(await autoplayAllowed(page)).toBe(true);
    // Not "hidden" — never rendered at all.
    await expect(startBtn(page)).toHaveCount(0);

    // The instrument is live immediately: the faceplate is there and the
    // transport answers, with nothing tapped to get here.
    await expect(page.getByRole('button', { name: 'Panic' })).toBeVisible();
  });

  test('the master is faded up from silence, not switched on (REQ-19)', async ({ page }) => {
    await quietBoot(page);
    await page.goto('/');
    await expect.poll(() => ctxState(page)).toBe('running');

    // The fade is 0 → master.volume² over RESUME_FADE_S, and it is the ONLY
    // thing that raises this gain — so once it has landed, the bus sits at the
    // volume law rather than at some intermediate value it was seeded with.
    const volume = await page.evaluate(() => (window as any).__synth.bus.get('master.volume') as number);
    const masterGain = (): Promise<number> =>
      page.evaluate(() => ((window as any).__synth?.engine.master.gain.value as number) ?? -1);
    await expect.poll(masterGain).toBeCloseTo(volume * volume, 2);
  });
});

test.describe('autoplay blocked — the modal is the gate', () => {
  /**
   * Present a context that reports itself suspended until something resumes it,
   * which is exactly what a blocking browser gives us and all `autoplayAllowed`
   * reads. The underlying context is real, so the tap still unlocks real audio.
   */
  const pretendBlocked = (page: import('@playwright/test').Page): Promise<void> =>
    page.addInitScript(() => {
      const Real = window.AudioContext;
      let blocked = true;
      class BlockedAudioContext extends Real {
        override get state(): AudioContextState {
          return blocked ? 'suspended' : super.state;
        }
        override async resume(): Promise<void> {
          blocked = false;
          return super.resume();
        }
      }
      window.AudioContext = BlockedAudioContext;
    });

  test('shows "Tap to start", and the tap unlocks the audio', async ({ page }) => {
    await pretendBlocked(page);
    await quietBoot(page);
    await page.goto('/');

    await expect(startBtn(page)).toBeVisible();
    expect(await autoplayAllowed(page)).toBe(false);

    // A Playwright click is a trusted gesture, so `engine.resume()` really runs.
    await startBtn(page).click();
    await expect(startBtn(page)).toBeHidden();
    await expect.poll(() => ctxState(page)).toBe('running');
  });
});
