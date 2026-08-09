import { test, expect } from '@playwright/test';
import { gotoAndStart, revealAllDemos } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The demo shelf — specs/features/demo-library.md REQ-6.
 *
 * The row used to be nineteen unlabelled buttons: no tempo, no length, no hint
 * of what any of them demonstrates, and ten of nineteen behind a fold. Every
 * button now carries what the index knows.
 *
 * No demo is named here — `tests/no-shipped-demo-names.test.ts` forbids it and
 * the row's contents are drop-in data anyway.
 */
test.describe('demo library', () => {
  test('every demo button says what it is, without being clicked', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await revealAllDemos(page);

    const buttons = page.locator('[data-testid^="song-demo-"]:not([data-testid="song-demo-more"])');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      const name = (await btn.textContent())?.trim() ?? '';
      const title = await btn.getAttribute('title');
      expect(title, `"${name}" has no title`).toBeTruthy();
      // The facts that make the row usable: a tempo and a length.
      expect(title, `"${name}" title: ${title}`).toMatch(/\d+ BPM/);
      expect(title).toMatch(/\d+ bars?/);
      // The name stays the visible label; the detail rides the tooltip.
      expect(title!.startsWith(name)).toBe(true);
      // Same sentence for a screen reader — `title` alone is not announced on a
      // button that already has a text label.
      expect(await btn.getAttribute('aria-label')).toContain(name);
    }
  });

  test('a demo with an armed control advertises it', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await revealAllDemos(page);

    // Which demos are armed is data, so ask the index rather than naming one.
    const armedNames: string[] = await page.evaluate(async () => {
      const mod = await import('/src/state/song.ts');
      return (mod as any).demoNames().filter((n: string) => {
        const meta = (mod as any).demoMetaFor(n);
        return meta?.armed?.length;
      });
    });
    // The corpus has both an armed arp and armed motion; if that ever stops
    // being true this test should be deleted, not weakened.
    expect(armedNames.length).toBeGreaterThan(0);

    for (const name of armedNames) {
      const title = await page.getByTestId(`song-demo-${name}`).getAttribute('title');
      expect(title, `"${name}" is armed but says nothing`).toMatch(/arp armed|motion ready/);
    }
  });
});
