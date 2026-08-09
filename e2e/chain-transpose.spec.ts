import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Per-slot arrangement transpose — arrangement.md REQ-8 and its gesture
 * inventory.
 *
 * Why it exists: a chain slot was a bare bank index, so four banks of sixteen
 * steps was a song's entire melodic vocabulary. One bank plus `A A+5 A+7` is now
 * a progression.
 */
test.describe('chain slot transpose', () => {
  const transposeOf = (page: any) =>
    page.evaluate(() => (window as any).__synth.engine.arrangement.seq.transpose as number[]);

  test('the +/- buttons transpose the selected slot, and the chip shows it', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // Two slots of bank A — the shape the whole feature exists for.
    await page.getByTestId('chain-add-seq-0').click();
    await expect(page.getByTestId('chain-chip-seq-1')).toBeVisible();

    // Nothing selected yet: the buttons must be inert, not throw.
    await page.getByTestId('chain-transpose-up-seq').click();
    expect(await transposeOf(page)).toEqual([0, 0]);

    await page.getByTestId('chain-chip-seq-1').click(); // select slot 1
    const up = page.getByTestId('chain-transpose-up-seq');
    await up.click();
    await up.click();
    await up.click();
    await up.click();
    await up.click();
    expect(await transposeOf(page)).toEqual([0, 5]);

    // The offset is ON the chip — a slot that plays a different pitch has to
    // look different without being selected first (ADR-014).
    await expect(page.getByTestId('chain-chip-seq-1')).toHaveText('A+5');
    await expect(page.getByTestId('chain-chip-seq-1')).toHaveAttribute('data-transposed', 'true');

    await page.getByTestId('chain-transpose-down-seq').click();
    expect(await transposeOf(page)).toEqual([0, 4]);
  });

  test('wheel nudges a slot and double-click resets it to +0', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('chain-add-seq-0').click();

    const chip = page.getByTestId('chain-chip-seq-1');
    await chip.hover();
    await page.mouse.wheel(0, -100); // up
    await page.mouse.wheel(0, -100);
    await expect.poll(() => transposeOf(page)).toEqual([0, 2]);

    // Double-click resets, matching the knob double-tap idiom.
    await chip.dblclick();
    await expect.poll(() => transposeOf(page)).toEqual([0, 0]);
    await expect(chip).toHaveText('A');
  });

  test('the offset travels with its slot when the slot is moved or removed', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('chain-add-seq-0').click();
    await page.getByTestId('chain-add-seq-1').click();

    await page.getByTestId('chain-chip-seq-2').click();
    await page.getByTestId('chain-transpose-up-seq').click();
    expect(await transposeOf(page)).toEqual([0, 0, 1]);

    // ◀ swaps the slot with its neighbour; the offset belongs to the slot, not
    // to the position, so it must swap too.
    await page.getByRole('button', { name: '◀', exact: true }).first().click();
    expect(await transposeOf(page)).toEqual([0, 1, 0]);

    // ✕ removes the selected slot — and its offset, not some other slot's.
    await page.getByRole('button', { name: '✕', exact: true }).first().click();
    expect(await transposeOf(page)).toEqual([0, 0]);
  });

  test('unpitched lanes have no transpose control at all', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    // Absent, not disabled: there is nothing for it to do on drums or the
    // sampler, and a control that does nothing is the defect this work removes.
    await expect(page.getByTestId('chain-transpose-up-drum')).toHaveCount(0);
    await expect(page.getByTestId('chain-transpose-up-sampler')).toHaveCount(0);
    await expect(page.getByTestId('chain-transpose-up-seq')).toHaveCount(1);
  });

  test('the offset the UI set is what the transport reads while playing', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('chain-add-seq-0').click();

    // Slot 1 up 7 semitones, set entirely through the UI.
    await page.getByTestId('chain-chip-seq-1').click();
    const up = page.getByTestId('chain-transpose-up-seq');
    for (let i = 0; i < 7; i++) await up.click();
    await expect(page.getByTestId('chain-chip-seq-1')).toHaveText('A+7');

    // Enable the chain and put the playhead in bar 2. `seqTranspose` is what the
    // StepSequencer actually adds to each note (sequencer.md REQ-16), so this is
    // the claim that matters: the gesture reached the audio thread's input.
    await page.evaluate(() => {
      const arr = (window as any).__synth.engine.arrangement;
      arr.setSeqChain(arr.seq.steps, true, arr.seq.transpose);
      arr.seekTo(16); // bar 2 = slot 1
    });
    await expect.poll(() => page.evaluate(
      () => (window as any).__synth.engine.arrangement.seqTranspose,
    )).toBe(7);

    await page.evaluate(() => (window as any).__synth.engine.arrangement.seekTo(0));
    await expect.poll(() => page.evaluate(
      () => (window as any).__synth.engine.arrangement.seqTranspose,
    )).toBe(0);
  });
});
