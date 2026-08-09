import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, clickDemo, pickDemo } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const drumOn = (page: Page, t: number, s: number): Promise<boolean> =>
  page.evaluate(([tt, ss]) => (window as any).__synth.patterns.drum[tt!][ss!].on, [t, s]);

const drumEditBank = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__synth.patterns.drumEditBank as number);

test.describe('pattern undo', () => {
  test('the drum panel Undo button reverts a step toggle and disables when spent', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    const undoBtn = page.getByTestId('undo-drum');
    await expect(undoBtn).toBeDisabled(); // fresh boot: nothing to undo

    await page.getByTestId('drum-step-3-5').click();
    expect(await drumOn(page, 3, 5)).toBe(true);
    await expect(undoBtn).toBeEnabled();

    await undoBtn.click();
    expect(await drumOn(page, 3, 5)).toBe(false);
    await expect(undoBtn).toBeDisabled();
  });

  test('Ctrl+Z undoes on the drum tab and is scoped to the active machine', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('drum-step-3-5').click();
    expect(await drumOn(page, 3, 5)).toBe(true);

    // On another machine's tab the drum stack is out of scope (seq is empty →
    // the key is inert), so the drum edit survives.
    await page.getByTestId('tab-seq').click();
    await page.keyboard.press('Control+z');
    expect(await drumOn(page, 3, 5)).toBe(true);

    await page.getByTestId('tab-drums').click();
    await page.keyboard.press('Control+z');
    await expect.poll(() => drumOn(page, 3, 5)).toBe(false);
  });

  test('undo returns to the bank the edit was made in', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    // Edit in bank B, then move the view to C.
    await page.getByTestId('bank-drum-1').click();
    await page.getByTestId('drum-step-3-5').click();
    await page.getByTestId('bank-drum-2').click();
    await expect.poll(() => drumEditBank(page)).toBe(2);

    await page.getByTestId('undo-drum').click();
    await expect.poll(() => drumEditBank(page)).toBe(1);
    expect(await drumOn(page, 3, 5)).toBe(false);
  });

  test('a bank copy is one undo step', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();

    // Give bank B distinctive content, back to A, copy A → B (wiping it).
    await page.getByTestId('bank-drum-1').click();
    await page.getByTestId('drum-step-3-5').click();
    await page.getByTestId('bank-drum-0').click();
    await page.getByTestId('bank-drum-copy').click();
    await page.getByTestId('bank-drum-1').click(); // armed copy lands in B
    expect(await drumOn(page, 3, 5)).toBe(false);  // B now mirrors A

    await page.getByTestId('undo-drum').click();   // one step restores B wholesale
    await expect.poll(() => drumOn(page, 3, 5)).toBe(true);
  });

  test('loading a demo clears the machine undo stacks', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('drum-step-3-5').click();
    await expect(page.getByTestId('undo-drum')).toBeEnabled();

    // A built-in: synchronous, so the undo stacks are cleared by the time the
    // click resolves. Which one is irrelevant — never name a demo.
    await page.getByTestId('tab-song').click();
    await clickDemo(page, (await pickDemo(page, 'built-in')).name);

    await page.getByTestId('tab-drums').click();
    await expect(page.getByTestId('undo-drum')).toBeDisabled();
  });
});
