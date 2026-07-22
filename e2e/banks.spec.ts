import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * Sequencer A/B/C/D bank switching via the BankBar. Editing a step writes to
 * the current edit bank; switching banks should reveal a different (here empty)
 * grid; the Copy arm clones the current bank into the next-clicked one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const stepOnInBank = (page: Page, bank: number, step: number) =>
  page.evaluate((a) => (window as any).__synth.patterns.seqBanks[a.bank][0][a.step].on as boolean, { bank, step });
const editBank = (page: Page) =>
  page.evaluate(() => (window as any).__synth.patterns.seqEditBank as number);

test.describe('sequencer banks', () => {
  test('editing, switching and copying banks', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();

    // Turn step 0 on in bank A (the default edit bank).
    if (!(await stepOnInBank(page, 0, 0))) {
      await page.getByTestId('seq-step-0').click();
    }
    expect(await stepOnInBank(page, 0, 0)).toBe(true);

    // Switch to bank B → its grid is independent and empty here. (The grid
    // renders from this same PatternStore state read via the bridge.)
    await page.getByTestId('bank-seq-1').click();
    expect(await editBank(page)).toBe(1);
    expect(await stepOnInBank(page, 1, 0)).toBe(false);

    // Copy bank A into bank B: select A, arm Copy, click B.
    await page.getByTestId('bank-seq-0').click();
    await page.getByTestId('bank-seq-copy').click();
    await page.getByTestId('bank-seq-1').click();

    expect(await editBank(page)).toBe(1); // copy also selects the target
    expect(await stepOnInBank(page, 1, 0)).toBe(true); // clone landed
  });

  test('Follow tracks the arrangement; a manual click disables it', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-seq').click();

    // Follow is on by default.
    await expect(page.getByTestId('bank-seq-follow')).toHaveClass(/\bon\b/);

    // Enable a seq chain A,B,B,B via the dev bridge and start the transport
    // (B holds for three bars so the manual-click step below can't race the
    // chain wrapping back to A).
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0, 1, 1, 1], true));
    await page.getByTestId('transport-play').click();

    // After a bar the play bank advances to B — the edit bank follows.
    await expect(page.getByTestId('bank-seq-1')).toHaveClass(/\bactive\b/, { timeout: 15_000 });
    expect(await editBank(page)).toBe(1);

    // Manually picking another bank while the song runs = editing intent:
    // Follow turns off and the view stays put from then on.
    await page.getByTestId('bank-seq-0').click();
    await expect(page.getByTestId('bank-seq-follow')).not.toHaveClass(/\bon\b/);
    expect(await editBank(page)).toBe(0);

    await page.getByTestId('transport-play').click(); // stop
  });
});
