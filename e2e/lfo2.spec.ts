import { test, expect } from '@playwright/test';
import { gotoAndStart, busSet, busGet } from './helpers';
import { SYNC_LABELS } from '../src/utils/tempo';
import { LFO_DEST_LABELS } from '../src/state/params';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The second LFO and the panel that hosts it — lfo.md REQ-10..REQ-15.
 *
 * The tab strip and the greyed-out destination are the two things only a real
 * browser can show: both are `display`/`disabled` state that the jsdom suite
 * asserts structurally, and here reads as a user would see it.
 */

const CUTOFF = LFO_DEST_LABELS.indexOf('cutoff');
const PAN = LFO_DEST_LABELS.indexOf('pan');
const QUARTER = SYNC_LABELS.indexOf('1/4');

/** The LFO 2 oscillator's live frequency, as `lfo-sync.spec.ts` reads LFO 1's. */
const lfo2Hz = (page: any): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.lfo2.osc.frequency.value as number);

/** How far LFO 2's pan output is opened — 0 until something routes it there. */
const lfo2PanGain = (page: any): Promise<number> =>
  page.evaluate(() => (window as any).__synth.engine.lfo2.toPan.gain.value as number);

test.describe('LFO 2', () => {
  test('is silent at boot, so an old patch sounds unchanged', async ({ page }) => {
    await gotoAndStart(page);
    expect(await busGet(page, 'lfo2.dest')).toBe(0);   // off
    expect(await busGet(page, 'lfo2.amount')).toBe(0);
    expect(await busGet(page, 'lfo2.sync')).toBe(0);   // free
    expect(await lfo2PanGain(page)).toBe(0);
  });

  test('the tab strip pages the LFO panel', async ({ page }) => {
    await gotoAndStart(page);
    const page1 = page.getByTestId('ppage-lfo-1');
    const page2 = page.getByTestId('ppage-lfo-2');

    await expect(page.getByTestId('knob-lfo.rate')).toBeVisible();
    await expect(page2).toBeHidden();

    await page.getByTestId('ptab-lfo-2').click();
    await expect(page.getByTestId('knob-lfo2.rate')).toBeVisible();
    await expect(page1).toBeHidden();

    await page.getByTestId('ptab-lfo-1').click();
    await expect(page.getByTestId('knob-lfo.rate')).toBeVisible();
  });

  // Only a real browser can measure this — jsdom has no layout engine.
  test('the tab row is exactly as tall as a plain panel header', async ({ page }) => {
    await gotoAndStart(page);
    const box = async (sel: string) => (await page.locator(sel).boundingBox())!.height;

    const tabRow = await box('[data-help="lfo"]');
    // Every untabbed faceplate panel, so this cannot pass against a stale one.
    for (const topic of ['ampenv', 'filterenv', 'mixer', 'filter']) {
      expect(await box(`[data-help="${topic}"]`), topic).toBeCloseTo(tabRow, 1);
    }
  });

  test('the tabs split the header evenly', async ({ page }) => {
    await gotoAndStart(page);
    const w = async (id: string) => (await page.getByTestId(`ptab-lfo-${id}`).boundingBox())!.width;
    expect(await w('1')).toBeCloseTo(await w('2'), 1);
  });

  test('a destination taken by LFO 1 is greyed out for LFO 2', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('ptab-lfo-2').click();

    const taken = page.getByTestId('dest-taken-lfo2');
    // The destination picker is the first of the page's two dropdowns (dest,
    // sync). Its options live in a popover, so open it — a closed menu is out
    // of the accessibility tree entirely.
    const destDd = page.getByTestId('ppage-lfo-2').locator('.dropdown').first();
    await destDd.locator('button').first().click();
    const cutoff = destDd.locator('button').filter({ hasText: /^cutoff$/i });

    await expect(cutoff).toBeEnabled();
    await expect(taken).toBeHidden();

    await busSet(page, 'lfo.dest', CUTOFF);
    await expect(cutoff).toBeDisabled();
    // Greyed, not gone — and the hint says who has it (ADR-014 law 5).
    await expect(cutoff).toBeVisible();
    await expect(taken).toHaveText('cutoff is used by LFO 1.');

    await busSet(page, 'lfo.dest', 0);
    await expect(cutoff).toBeEnabled();
    await expect(taken).toBeHidden();
  });

  test('routing LFO 2 to pan actually opens its pan output', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'lfo2.dest', PAN);
    await busSet(page, 'lfo2.amount', 1);
    // rampTo is a setTargetAtTime, so poll to convergence.
    await expect.poll(() => lfo2PanGain(page), { timeout: 4000 }).toBeGreaterThan(0.9);
  });

  test('tempo-locks independently of LFO 1', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'transport.bpm', 120);
    await busSet(page, 'lfo2.rate', 7);

    await busSet(page, 'lfo2.sync', QUARTER);   // 1/4 at 120 BPM = 2 Hz
    await expect.poll(() => lfo2Hz(page), { timeout: 4000 }).toBeCloseTo(2, 1);

    await busSet(page, 'lfo2.sync', 0);
    await expect.poll(() => lfo2Hz(page), { timeout: 4000 }).toBeCloseTo(7, 1);
    expect(await busGet(page, 'lfo2.rate')).toBeCloseTo(7, 5);
  });

  test('the tab lights while the hidden page is modulating', async ({ page }) => {
    await gotoAndStart(page);
    const tab2 = page.getByTestId('ptab-lfo-2');
    await expect(tab2).not.toHaveClass(/\blit\b/);

    await busSet(page, 'lfo2.dest', PAN);
    await busSet(page, 'lfo2.amount', 0.6);
    // Still on page 1 — the lamp is the only thing saying LFO 2 is working.
    await expect(page.getByTestId('ppage-lfo-2')).toBeHidden();
    await expect(tab2).toHaveClass(/\blit\b/);

    await busSet(page, 'lfo2.amount', 0);
    await expect(tab2).not.toHaveClass(/\blit\b/);
  });
});
