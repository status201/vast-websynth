import { test, expect } from '@playwright/test';
import { gotoAndStart, busSet } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const seqOn = (page: import('@playwright/test').Page, i: number): Promise<boolean> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[0][idx].on, i);
const seqNote = (page: import('@playwright/test').Page, i: number): Promise<number> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[0][idx].note, i);
const playNote = (page: import('@playwright/test').Page, n: number): Promise<void> =>
  page.evaluate((note) => (window as any).__synth.bus.noteOn(note), n);
const drumOn = (page: import('@playwright/test').Page, t: number, s: number): Promise<boolean> =>
  page.evaluate((a) => (window as any).__synth.patterns.drum[a.t][a.s].on, { t, s });
const clockStep = (page: import('@playwright/test').Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.clock.step);

/**
 * Grid edits flow UI click → PatternStore (read back via the bridge), and the
 * transport actually advances the look-ahead clock.
 */
test.describe('pattern grids', () => {
  test('sequencer step click toggles PatternStore', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    const before = await seqOn(page, 5);
    await page.getByTestId('seq-step-5').click();
    expect(await seqOn(page, 5)).toBe(!before);
    await page.getByTestId('seq-step-5').click();
    expect(await seqOn(page, 5)).toBe(before);
  });

  test('step record fills steps from played notes and advances', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();

    // Arm Step Input, then "play" notes — each lands in the selected step and
    // the cursor advances on its own (starts at step 0).
    await page.getByTestId('seq-step-input').click();
    await playNote(page, 64);
    await playNote(page, 67);
    expect(await seqNote(page, 0)).toBe(64);
    expect(await seqOn(page, 0)).toBe(true);
    expect(await seqNote(page, 1)).toBe(67);

    // While armed, clicking a step only moves the cursor (no on/off toggle).
    const before = await seqOn(page, 8);
    await page.getByTestId('seq-step-8').click();
    expect(await seqOn(page, 8)).toBe(before);
    await playNote(page, 72);
    expect(await seqNote(page, 8)).toBe(72);
  });

  // sequencer.md REQ-5 — Step Input listens on the global note funnel, so
  // without this gate any note played anywhere in the app overwrote the grid.
  test('leaving the tab disarms Step Input, so other tabs cannot record', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    const armBtn = page.getByTestId('seq-step-input');
    await armBtn.click();
    await expect(armBtn).toHaveClass(/(^|\s)on(\s|$)/);

    // Fiddling with the Arpeggiator: notes still play, but nothing is recorded.
    await page.getByTestId('tab-arp').click();
    await playNote(page, 64);
    await playNote(page, 67);
    await playNote(page, 71);
    expect(await seqOn(page, 0)).toBe(false);
    expect(await seqOn(page, 1)).toBe(false);
    expect(await seqOn(page, 2)).toBe(false);

    // Back on the tab it stays disarmed — the arm must be deliberate, never
    // silently resumed.
    await page.getByTestId('tab-seq').click();
    await expect(armBtn).not.toHaveClass(/(^|\s)on(\s|$)/);
    await playNote(page, 64);
    expect(await seqOn(page, 0)).toBe(false);
  });

  // sequencer.md REQ-6 — Follow would otherwise drag the edit bank along with
  // the arrangement, spraying one take across all four banks.
  test('arming Step Input pins the take by turning Bank Follow off', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    const follow = page.getByTestId('bank-seq-follow');
    await expect(follow).toHaveClass(/(^|\s)on(\s|$)/); // on by default

    await page.getByTestId('seq-step-input').click();
    await expect(follow).not.toHaveClass(/(^|\s)on(\s|$)/);

    // Disarming leaves Follow off — the user re-enables it deliberately.
    await page.getByTestId('seq-step-input').click();
    await expect(follow).not.toHaveClass(/(^|\s)on(\s|$)/);
  });

  test('one computer key fills exactly one step (no double-trigger)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-step-input').click();

    // A real (trusted) keydown routes through installShortcuts + the UiBridge
    // exactly as in production, unlike playNote()'s direct bus.noteOn. 'x' = D at
    // the default base octave (MIDI 62). A single key must advance the cursor by
    // one — the bridge highlight is visual-only, so no second note-on fires.
    await page.keyboard.press('x');
    expect(await seqOn(page, 0)).toBe(true);
    expect(await seqNote(page, 0)).toBe(62);
    // Step 1 stays empty: the cursor moved by one, not two.
    expect(await seqOn(page, 1)).toBe(false);
  });

  test('per-step settings show up on the step button', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();

    // Click selects step 0 (and toggles it — re-click if it landed off);
    // edit-row buttons then act on the selected step.
    await page.getByTestId('seq-step-0').click();
    if (!(await seqOn(page, 0))) await page.getByTestId('seq-step-0').click();
    await page.getByTestId('seq-ratchet-3').click();
    await page.getByTestId('seq-tie').click();

    // CSS-module class names are hashed, so assert via the inline custom
    // props the StepButton writes plus the value tooltip.
    const step = page.getByTestId('seq-step-0');
    expect(await step.evaluate((el) => el.style.getPropertyValue('--sb-ratchet'))).toBe('3');
    expect(await step.evaluate((el) => el.style.getPropertyValue('--sb-gate'))).toBe('0.5');
    await expect(step).toHaveAttribute('title', /vel 80% · gate 50% · prob 100% · ×3 · tie/);
  });

  test('drum cell click toggles PatternStore', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    const before = await drumOn(page, 0, 0);
    await page.getByTestId('drum-step-0-0').click();
    expect(await drumOn(page, 0, 0)).toBe(!before);
  });

  test('drum per-step settings show up on the cell', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    // Click selects the cell (and toggles it — re-click if it landed off);
    // the shared edit row below the grid then acts on the selection.
    await page.getByTestId('drum-step-1-4').click();
    if (!(await drumOn(page, 1, 4))) await page.getByTestId('drum-step-1-4').click();
    await page.getByTestId('drum-ratchet-3').click();
    await page.getByTestId('drum-tie').click();

    const cell = page.getByTestId('drum-step-1-4');
    expect(await cell.evaluate((el) => el.style.getPropertyValue('--sb-ratchet'))).toBe('3');
    expect(await cell.evaluate((el) => el.style.getPropertyValue('--sb-gate'))).toBe('1');
    await expect(cell).toHaveAttribute('title', /vel 85% · gate 100% · prob 100% · ×3 · tie/);
  });

  test('sampler per-step settings show up on the cell', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await page.getByTestId('sampler-step-0-0').click(); // empty grid → turns on + selects
    await page.getByTestId('sampler-tie').click();

    const cell = page.getByTestId('sampler-step-0-0');
    await expect(cell).toHaveAttribute('title', /vel 85% · gate 100% · prob 100% · tie/);
    expect(await page.evaluate(() => (window as any).__synth.patterns.sampler[0][0].tie)).toBe(true);
  });

  test('transport advances the clock', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('transport-play').click();
    await expect.poll(() => clockStep(page), { timeout: 4000 }).toBeGreaterThan(2);
    await page.getByTestId('transport-play').click(); // stop
  });
});

/**
 * The shared gesture model — specs/features/step-grid-editing.md. These drive
 * the real pointer stack (Playwright's mouse emits pointerdown/move/up), which
 * is the only place the hold timer and the paint latch are exercised end to end.
 */
test.describe('step-grid gestures', () => {
  test('holding a lit step selects it for editing without switching it off', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();

    // Light step 5, then hold it: the freak-out regression is that this used to
    // turn it back off before the user could touch the edit row.
    await page.getByTestId('seq-step-5').click();
    expect(await seqOn(page, 5)).toBe(true);

    const box = (await page.getByTestId('seq-step-5').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(500); // past the 350ms hold window
    await page.mouse.up();

    expect(await seqOn(page, 5)).toBe(true);
    await expect(page.getByTestId('seq-vel')).toBeVisible();
  });

  test('right-click selects a lit step without toggling it', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-step-3').click();
    expect(await seqOn(page, 3)).toBe(true);
    await page.getByTestId('seq-step-3').click({ button: 'right' });
    expect(await seqOn(page, 3)).toBe(true);
  });

  test('dragging across drum cells paints a run in one gesture', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    // Clear the row first so the latch is unambiguous (kick boots with a groove).
    await page.getByTestId('clear-drum').click();
    await page.getByTestId('clear-drum-row').click();
    expect(await drumOn(page, 0, 0)).toBe(false);

    const from = (await page.getByTestId('drum-step-0-1').boundingBox())!;
    const to = (await page.getByTestId('drum-step-0-5').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Several intermediate moves: one jump would skip the cells in between.
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(
        from.x + from.width / 2 + ((to.x - from.x) * i) / 8,
        from.y + from.height / 2,
      );
    }
    await page.mouse.up();

    for (let s = 1; s <= 5; s++) expect(await drumOn(page, 0, s)).toBe(true);
    expect(await drumOn(page, 0, 6)).toBe(false);
  });

  test('Clear bank wipes the grid and the toast Undo brings it back in one press', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    expect(await drumOn(page, 0, 0)).toBe(true); // seeded four-on-the-floor

    await page.getByTestId('clear-drum').click();
    await page.getByTestId('clear-drum-bank').click();
    expect(await drumOn(page, 0, 0)).toBe(false);
    expect(await drumOn(page, 1, 4)).toBe(false);

    await page.getByTestId('toast-action').click();
    expect(await drumOn(page, 0, 0)).toBe(true);
    expect(await drumOn(page, 1, 4)).toBe(true);
  });

  test('Delete clears the selected step, and only on the visible tab', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-step-6').click();
    expect(await seqOn(page, 6)).toBe(true);

    await page.keyboard.press('Delete');
    expect(await seqOn(page, 6)).toBe(false);

    // Re-light it, leave the tab, and confirm the key can no longer reach it.
    await page.getByTestId('seq-step-6').click();
    expect(await seqOn(page, 6)).toBe(true);
    await page.getByTestId('tab-sampler').click();
    await page.keyboard.press('Delete');
    expect(await seqOn(page, 6)).toBe(true);
  });
});

/**
 * Four sequencer tracks — specs/features/sequencer.md REQ-8..REQ-13.
 */
test.describe('sequencer tracks', () => {
  const trackOn = (page: import('@playwright/test').Page, t: number, i: number): Promise<boolean> =>
    page.evaluate((a) => (window as any).__synth.patterns.seq[a.t][a.i].on, { t, i });

  test('tracks 2-4 start folded when empty and unfold on demand', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    // Track 1 always shows its steps; the rest start folded (nothing to show).
    await expect(page.getByTestId('seq-step-0')).toBeVisible();
    await expect(page.getByTestId('seq-step-1-0')).toBeHidden();

    await page.getByTestId('seq-track-fold-1').click();
    await expect(page.getByTestId('seq-step-1-0')).toBeVisible();
  });

  test('a second track adds a simultaneous note', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-track-fold-1').click();

    await page.getByTestId('seq-step-0').click();
    await page.getByTestId('seq-step-1-0').click();
    expect(await trackOn(page, 0, 0)).toBe(true);
    expect(await trackOn(page, 1, 0)).toBe(true);
    // Independent data: clearing track 1's step leaves track 2 alone.
    await page.getByTestId('seq-step-0').click();
    expect(await trackOn(page, 0, 0)).toBe(false);
    expect(await trackOn(page, 1, 0)).toBe(true);
  });

  test('four-track songs round-trip and reopen their tracks', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-track-fold-2').click();
    await page.getByTestId('seq-step-2-4').click();
    expect(await trackOn(page, 2, 4)).toBe(true);

    await page.getByTestId('tab-song').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await page.getByTestId('dialog-input').fill('e2e-seqtracks');
    await page.getByTestId('dialog-confirm').click();
    await download;
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

    // The stored file is v6 and carries the track under seqTracks (index 0 null).
    const stored = await page.evaluate(() =>
      localStorage.getItem('websynth.song.e2e-seqtracks'));
    const parsed = JSON.parse(stored!) as { version: number; seqTracks: unknown[][] };
    expect(parsed.version).toBe(6);
    expect(parsed.seqTracks[0]![0]).toBeNull();

    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-confirm').click();
    expect(await trackOn(page, 2, 4)).toBe(false);

    await page.getByTestId('song-load').click();
    expect(await trackOn(page, 2, 4)).toBe(true);
  });

  test('mono voicing dims tracks 2-4 without losing their steps', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-track-fold-1').click();
    await page.getByTestId('seq-step-1-0').click();

    await busSet(page, 'voicing.mode', 0); // mono
    await expect(page.getByTestId('seq-track-1')).toHaveAttribute('title', /mono voicing/);
    expect(await trackOn(page, 1, 0)).toBe(true); // data intact

    await busSet(page, 'voicing.mode', 1); // poly
    await expect(page.getByTestId('seq-track-1')).toHaveAttribute('title', '');
  });
});
