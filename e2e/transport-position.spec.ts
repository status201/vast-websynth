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
 * Index of the tick carrying a given marker class, or -1. Both markers are
 * **global** state classes — every other class on these buttons is CSS-Module
 * hashed — so they are the only selectable thing here.
 *
 * `playing` is the live playhead and exists **only while playing**; `cue` is
 * where Play will begin (transport-position.md REQ-14). v1 conflated the two.
 */
const markedTick = (page: Page, lane: string, cls: string): Promise<number> =>
  page.evaluate(([l, c]) => {
    const ticks = [...document.querySelectorAll(`[data-testid="ruler-${l}"] button`)];
    return ticks.findIndex((t) => t.classList.contains(c!));
  }, [lane, cls]);
const litTick = (page: Page, lane: string): Promise<number> => markedTick(page, lane, 'playing');
const cueTick = (page: Page, lane: string): Promise<number> => markedTick(page, lane, 'cue');

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
    expect(await cueTick(page, 'sampler')).toBe(9);
    // No chain is enabled, so the readout names the bank rather than inventing a
    // bar number for a one-bank loop (REQ-15).
    await expect(page.getByTestId('ruler-sampler-bar')).toHaveText('Bank A');
  });

  test('Home returns to the top and Shift+Arrow moves a bar', async ({ page }) => {
    await gotoAndStart(page);
    // A chain makes bars real, which is the only state where a bar readout means
    // anything — without one the readout names the bank instead (REQ-15).
    await setSeqChain(page, [0, 0, 1, 0]);
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

  // --- v2: the cue is its own mark (REQ-14) ---
  test('a stopped ruler shows a cue and no playhead, and Play starts there', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    await page.getByTestId('ruler-drum-6').click();
    expect(await cueTick(page, 'drum')).toBe(6);
    // Nothing is playing, so nothing may look like it is — this is the confusion
    // v1 caused by painting the cue with the `playing` class.
    expect(await litTick(page, 'drum')).toBe(-1);

    await page.getByTestId('transport-play').click();
    await expect.poll(() => playing(page)).toBe(true);
    await expect.poll(() => litTick(page, 'drum')).toBeGreaterThanOrEqual(0);
    // The cue ring stays put while the playhead runs, so Stop → Play is legible.
    expect(await cueTick(page, 'drum')).toBe(6);
    await page.getByTestId('transport-play').click();
  });

  // --- v2: the readout names the bank, and the stepper walks bars (REQ-15/16) ---
  test('the readout follows the bank, then becomes a bar stepper once chained', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    const readout = page.getByTestId('ruler-drum-bar');
    await expect(readout).toHaveText('Bank A');
    await expect(page.getByTestId('ruler-drum-bar-next')).toBeHidden();

    // The readout tracks the same bank the A/B/C/D bar selects.
    await page.getByTestId('bank-drum-2').click();
    await expect(readout).toHaveText('Bank C');

    // Chaining makes bars real: the stepper appears and the bar wraps at length.
    await setSeqChain(page, [0, 0, 1, 0]);
    await expect(readout).toHaveText('Bar 1/4');
    const next = page.getByTestId('ruler-drum-bar-next');
    await expect(next).toBeVisible();

    // Park mid-bar, then step a bar: the 16th must survive (Shift+Arrow zeroes it).
    await page.getByTestId('ruler-drum-5').click();
    await next.click();
    expect(await clockStep(page)).toBe(SEQ_LENGTH + 5);
    await expect(readout).toHaveText('Bar 2/4');

    // Clamped at bar 1 rather than going negative.
    await page.getByTestId('ruler-drum-bar-prev').click();
    await page.getByTestId('ruler-drum-bar-prev').click();
    expect(await clockStep(page)).toBe(5);
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

  /**
   * A ruler that does not sit over its steps marks nothing (REQ-9).
   *
   * The sampler panel got this wrong for real: its slot rows widened their control
   * cluster to fit a filename while the ruler row kept the drum panel's bare width,
   * so every tick sat 80px left of the step it named. Nothing caught it — the ruler
   * was present, visible and correct, just in the wrong place — so this measures
   * the geometry rather than trusting the class names to agree.
   */
  test('the ruler tick sits over the step it marks, on every tab', async ({ page }) => {
    await gotoAndStart(page);
    for (const [tab, lane, step] of [
      ['seq', 'seq', 'seq-step-0'], ['drums', 'drum', 'drum-step-0-0'],
      ['sampler', 'sampler', 'sampler-step-0-0'], ['motion', 'motion', 'motion-step-0'],
    ]) {
      await page.getByTestId(`tab-${tab}`).click();
      const tick = await page.getByTestId(`ruler-${lane}-0`).boundingBox();
      const cell = await page.getByTestId(step!).boundingBox();
      expect(tick, `${lane} ruler tick`).not.toBeNull();
      expect(cell, `${lane} first step`).not.toBeNull();
      // Same left edge, within a pixel of rounding.
      expect(Math.abs(tick!.x - cell!.x), `${lane} ruler is ${tick!.x - cell!.x}px off`)
        .toBeLessThanOrEqual(1);
    }
  });

  test('the ruler re-syncs to the current step when its tab is revealed', async ({ page }) => {
    await gotoAndStart(page);
    // Chained, so the bar readout is a bar (REQ-15) and this still asserts it.
    await setSeqChain(page, [0, 0, 1, 0]);
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('ruler-drum-2').click();
    // Stopped, so the mark is the cue rather than a playhead (REQ-14).
    expect(await cueTick(page, 'drum')).toBe(2);

    // Move the playhead while the drum panel is off screen. Its ruler must not
    // repaint there (transport-position.md REQ-10) but must catch up on reveal,
    // never opening on the column it was left on.
    await page.getByTestId('tab-seq').click();
    await page.evaluate((n) => (window as any).__synth.engine.seekTo(n), SEQ_LENGTH * 3 + 12);
    await page.getByTestId('tab-drums').click();

    expect(await cueTick(page, 'drum')).toBe(12);
    await expect(page.getByTestId('ruler-drum-bar')).toContainText('4');
  });
});
