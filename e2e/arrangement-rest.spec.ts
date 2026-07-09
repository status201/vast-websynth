import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('arrangement rest slot', () => {
  test('Song tab appends a rest chip and the REST sentinel to a lane chain', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // A lane chain starts as a single bank slot [A]. Add a rest bar.
    await page.getByTestId('chain-add-rest-seq').click();

    // The appended chip is marked as a rest (a glyph, not a letter).
    await expect(
      page.locator('[data-testid^="chain-chip-seq-"][data-rest="true"]'),
    ).toHaveCount(1);

    // The underlying chain step is the REST sentinel (-1).
    const steps = await page.evaluate(
      () => (window as any).__synth.engine.arrangement.seq.steps as number[],
    );
    expect(steps[steps.length - 1]).toBe(-1);
  });

  test('machine tab overlays the grid while its lane is resting', async ({ page }) => {
    await gotoAndStart(page);

    // Enable a seq chain whose only slot is a rest; recompute() sets seqResting.
    await page.evaluate(() =>
      (window as any).__synth.engine.arrangement.setSeqChain([-1], true),
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).__synth.engine.arrangement.seqResting))
      .toBe(true);

    await page.getByTestId('tab-seq').click();
    await expect(page.getByTestId('rest-overlay-seq')).toBeVisible();
  });
});
