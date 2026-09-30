import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * keyboard-range.md REQ-key-height-follows-key-width / REQ-spare-height-goes-to-the-scope.
 *
 * A white key stays between 1.6x and 4.5x as tall as it is wide (over a 160px
 * row floor), and the height the keyboard cannot use goes to the scope. All of it
 * is flex sizing against a real viewport, which jsdom cannot lay out.
 *
 * The fold states are the three sections that can hand the keyboard height:
 * FX, Machines (`pattern`) and the EQ, preset through their stored collapse flags.
 */
type Folds = { fx: boolean; pattern: boolean; eq: boolean };
const FOLDED: Folds = { fx: true, pattern: true, eq: true };
const DEFAULT: Folds = { fx: false, pattern: false, eq: true };
const EXPANDED: Folds = { fx: false, pattern: false, eq: false };

async function open(page: Page, width: number, height: number, folds: Folds): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((f) => {
    try {
      localStorage.setItem('websynth.ui.collapsed.fx', f.fx ? '1' : '0');
      localStorage.setItem('websynth.ui.collapsed.pattern', f.pattern ? '1' : '0');
      localStorage.setItem('websynth.ui.collapsed.eq', f.eq ? '1' : '0');
    } catch { /* ignore */ }
  }, folds);
  await gotoAndStart(page);
}

interface Measure { keyW: number; keyH: number; ratio: number; scopeH: number; kbBottom: number; kbRowH: number }

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const wrap = document.querySelector('[data-testid="keyboard"]') as HTMLElement;
    // White keys are the flow children; black keys are positioned inline.
    const white = [...wrap.querySelectorAll<HTMLElement>('[data-note]')].find((k) => !k.style.left)!;
    const r = white.getBoundingClientRect();
    // The rule's width is the key's COLUMN — its box plus the 1px margin either
    // side — which is what the keys' content width divided by their count gives.
    const col = r.width + 2;
    const scope = (document.querySelector('[data-testid="scope-toggle"]') as HTMLElement)
      .parentElement!.getBoundingClientRect();
    const kb = wrap.getBoundingClientRect();
    return {
      keyW: col, keyH: r.height, ratio: r.height / col,
      scopeH: scope.height, kbBottom: kb.bottom + window.scrollY - window.innerHeight, kbRowH: kb.height,
    };
  });
}

test.describe('keyboard height', () => {
  test('folded panels cap the keys and grow the scope', async ({ page }) => {
    await open(page, 2739, 1330, FOLDED);
    const m = await measure(page);
    expect(m.ratio, `key ${m.keyW.toFixed(1)}x${m.keyH.toFixed(1)}`).toBeLessThanOrEqual(4.5 + 0.05);
    // The keyboard is AT its cap, not merely under it: the spare went elsewhere.
    expect(m.ratio).toBeGreaterThan(4.4);
    expect(m.scopeH, 'the scope took the spare').toBeGreaterThan(200);
  });

  test('a 1440p default layout is unchanged', async ({ page }) => {
    await open(page, 2560, 1440, DEFAULT);
    const m = await measure(page);
    expect(m.ratio).toBeGreaterThan(4.1);
    expect(m.ratio).toBeLessThanOrEqual(4.5 + 0.05);
    expect(Math.round(m.scopeH), 'no spare past the cap here').toBe(130);
  });

  test('full HD keeps its keyboard on screen', async ({ page }) => {
    await open(page, 1920, 1080, DEFAULT);
    const m = await measure(page);
    expect(m.ratio).toBeGreaterThanOrEqual(1.6 - 0.05);
    expect(m.kbBottom, 'keyboard ends inside the viewport').toBeLessThanOrEqual(0);
  });

  test('a narrow key keeps the 160px floor', async ({ page }) => {
    await open(page, 1440, 900, DEFAULT);
    const m = await measure(page);
    // 1.6 x ~62px + 30 is under 160: the floor wins.
    expect(Math.round(m.kbRowH)).toBe(160);
    expect(Math.round(m.keyH)).toBe(130);
  });

  test('no spare height means the page scrolls, not the keys shrinking', async ({ page }) => {
    await open(page, 1920, 1080, EXPANDED);
    const m = await measure(page);
    // At the minimum band edge (1.6x) — or the floor, whichever is taller.
    expect(m.keyH).toBeGreaterThanOrEqual(Math.max(130, 1.6 * m.keyW) - 1.5);
    expect(m.keyH).toBeLessThanOrEqual(Math.max(130, 1.6 * m.keyW) + 1.5);
    expect(Math.round(m.scopeH)).toBe(130);
  });
});
