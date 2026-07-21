import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const seqOn = (page: import('@playwright/test').Page, i: number): Promise<boolean> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[idx].on, i);
const seqNote = (page: import('@playwright/test').Page, i: number): Promise<number> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[idx].note, i);
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
