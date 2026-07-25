import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const clockStep = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.clock.step);
const clockCue = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.clock.cue);
const playing = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).__synth.engine.clock.playing);
const seqPlayBank = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.arrangement.seqPlayBank);
const setSeqChain = (page: Page, steps: number[]): Promise<void> =>
  page.evaluate((s) => (window as any).__synth.engine.arrangement.setSeqChain(s, true), steps);

const SEQ_LENGTH = 16;

/**
 * Index of the ruler tick the transport is on. The marker is the **global**
 * `playing` state class — every other class on these buttons is CSS-Module
 * hashed — so exactly one tick carries it.
 */
const litTick = (page: Page, lane: string): Promise<number> =>
  page.evaluate((l) => {
    const ticks = [...document.querySelectorAll(`[data-testid="ruler-${l}"] button`)];
    return ticks.findIndex((t) => t.classList.contains('playing'));
  }, lane);

/**
 * Moving the playhead (transport-position.md): the per-grid ruler and the
 * keyboard shortcuts, against the real clock in Chromium.
 */
test.describe('transport position', () => {
  test('clicking the ruler moves the playhead while playing', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('transport-play').click();
    await expect.poll(() => playing(page)).toBe(true);

    await page.getByTestId('ruler-drum-7').click();
    // The jump is immediate, but the clock keeps advancing — so assert the
    // ruler landed us in the right *bar position*, not on an exact step.
    const step = await clockStep(page);
    expect(step % SEQ_LENGTH).toBeGreaterThanOrEqual(7);
    expect(await playing(page)).toBe(true);

    await page.getByTestId('transport-play').click();
  });

  test('a seek while stopped cues where Play begins', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();

    await page.getByTestId('ruler-seq-4').click();
    expect(await clockCue(page)).toBe(4);
    expect(await clockStep(page)).toBe(4);

    await page.getByTestId('transport-play').click();
    // start() with no argument honours the cue, so playback began at step 4 and
    // has only moved forward from there.
    await expect.poll(() => clockStep(page)).toBeGreaterThanOrEqual(4);
    await page.getByTestId('transport-play').click();
  });

  test('the ruler shows the position on a machine that is switched off', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    // The sampler is off by default, so its grid playhead never lights — the
    // ruler is the only surface that answers "where are we?".
    await page.getByTestId('ruler-sampler-9').click();
    expect(await clockStep(page)).toBe(9);
    await expect(page.getByTestId('ruler-sampler-bar')).toContainText('1');
  });

  test('Home returns to the top and Shift+Arrow moves a bar', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    await page.getByTestId('ruler-drum-5').click();
    expect(await clockStep(page)).toBe(5);

    await page.keyboard.press('Shift+ArrowRight');
    expect(await clockStep(page)).toBe(SEQ_LENGTH);
    await expect(page.getByTestId('ruler-drum-bar')).toContainText('2');

    await page.keyboard.press('Shift+ArrowLeft');
    expect(await clockStep(page)).toBe(0);

    await page.getByTestId('ruler-drum-11').click();
    await page.keyboard.press('Home');
    expect(await clockStep(page)).toBe(0);
    await expect(page.getByTestId('ruler-drum-bar')).toContainText('1');
  });

  test('Shift+Arrow does not shift the keyboard octave', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');

    // The bare arrows own the octave shift, and the shifted ones must not have
    // reached that branch: 'z' still plays C4 (MIDI 60).
    const notes: number[] = [];
    await page.exposeFunction('__seenNote', (n: number) => { notes.push(n); });
    await page.evaluate(() => {
      (window as any).__synth.bus.onNote((on: boolean, note: number) => {
        if (on) (window as any).__seenNote(note);
      });
    });
    await page.keyboard.press('z');
    await expect.poll(() => notes).toContain(60);
  });

  test('a seek re-seeks the arrangement chain to that bar', async ({ page }) => {
    await gotoAndStart(page);
    await setSeqChain(page, [0, 0, 1, 0]); // A A B A
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('transport-play').click();
    await expect.poll(() => playing(page)).toBe(true);

    // Bar 3 (0-indexed 2) is the "B" slot — reachable immediately instead of
    // waiting two bars for it to come round.
    await page.evaluate((n) => (window as any).__synth.engine.seekTo(n), SEQ_LENGTH * 2);
    expect(await seqPlayBank(page)).toBe(1);

    await page.getByTestId('transport-play').click();
  });

  test('every machine tab carries a ruler', async ({ page }) => {
    await gotoAndStart(page);
    // The drum tab's id is `drums`; its lane (and so its testids) is `drum`.
    for (const [tab, lane] of [
      ['seq', 'seq'], ['drums', 'drum'], ['sampler', 'sampler'], ['motion', 'motion'],
    ]) {
      await page.getByTestId(`tab-${tab}`).click();
      await expect(page.getByTestId(`ruler-${lane}-0`)).toBeVisible();
      await expect(page.getByTestId(`ruler-${lane}-bar`)).toBeVisible();
    }
  });

  test('the ruler re-syncs to the current step when its tab is revealed', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('ruler-drum-2').click();
    expect(await litTick(page, 'drum')).toBe(2);

    // Move the playhead while the drum panel is off screen. Its ruler must not
    // repaint there (transport-position.md REQ-10) but must catch up on reveal,
    // never opening on the column it was left on.
    await page.getByTestId('tab-seq').click();
    await page.evaluate((n) => (window as any).__synth.engine.seekTo(n), SEQ_LENGTH * 3 + 12);
    await page.getByTestId('tab-drums').click();

    expect(await litTick(page, 'drum')).toBe(12);
    await expect(page.getByTestId('ruler-drum-bar')).toContainText('4');
  });
});
