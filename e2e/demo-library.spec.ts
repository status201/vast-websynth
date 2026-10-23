import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, revealAllDemos, renderedDemoNames, visibleDemoNames, zipDemos } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The demo shelf — specs/features/demo-library.md REQ-demo-row-says-what-it-knows.
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

  /**
   * song-mode.md REQ-drop-in-demos-are-fetched-on-click (v20). The row used to be the three demo sources
   * concatenated, which pinned the project zips to the end — so the library's
   * most feature-complete demo sat in the "All Demos" fold purely for being a
   * `.zip`. Which source a demo loads from is not something a listener can see.
   */
  test('the row reads alphabetically, with the project zips in their place', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await revealAllDemos(page);

    const rendered = await renderedDemoNames(page);
    expect(rendered.length).toBeGreaterThan(0);

    // The same comparator src/state/song.ts uses (compareSongNames).
    const sorted = [...rendered].sort(
      (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    expect(rendered).toEqual(sorted);

    // And the regression itself: no zip is parked at the end for being a zip.
    for (const zip of zipDemos()) {
      expect(rendered.indexOf(zip.name), zip.name).toBe(sorted.indexOf(zip.name));
    }
  });
});

/**
 * The library window and the loaded demo's ⓘ — demo-library.md
 * REQ-the-library-reads-without-loading, REQ-the-loaded-demo-carries-an-info-button,
 * REQ-info-mode-badges-the-demo-row-once. The title above is hover-only, so a touch
 * screen never saw it; these are the doors that work without a hover.
 */
test.describe('demo info without a hover', () => {
  /** The testid of whatever sits right after a demo's button. */
  const nextAfter = (page: Page, name: string): Promise<string | undefined> =>
    page.getByTestId(`song-demo-${name}`).evaluate(
      (b) => (b.nextElementSibling as HTMLElement | null)?.dataset.testid);

  /** Two demos in the unfolded row — any two, never named (no-shipped-demo-names). */
  async function twoDemos(page: Page): Promise<[string, string]> {
    const names = await visibleDemoNames(page);
    expect(names.length).toBeGreaterThan(1);
    return [names[0]!, names[1]!];
  }

  const entryFor = (page: Page, name: string) =>
    page.getByTestId('demo-library-entry')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });

  test('the loaded demo carries an ⓘ that opens its notes', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    const [a] = await twoDemos(page);

    await expect(page.getByTestId('demo-loaded-info')).toHaveCount(0);
    await page.getByTestId(`song-demo-${a}`).click();
    await expect(page.getByTestId('demo-loaded-info')).toBeVisible();
    expect(await nextAfter(page, a)).toBe('demo-loaded-info');

    await page.getByTestId('demo-loaded-info').click();
    await expect(page.getByTestId('demo-library')).toBeVisible();
    const marked = page.locator('[data-testid="demo-library-entry"][aria-current="true"]');
    await expect(marked).toHaveCount(1);
    await expect(marked.getByRole('heading')).toContainText(a);
    // v4: already playing, so its button says so and does nothing; its notes
    // (if it has any) open unfolded — they are what the ⓘ was pressed for.
    await expect(marked.getByTestId('demo-library-load')).toHaveText('Loaded');
    await expect(marked.getByTestId('demo-library-load')).toBeDisabled();
    const more = marked.getByTestId('demo-library-more');
    if (await more.count() > 0) await expect(more).toHaveAttribute('aria-expanded', 'true');
  });

  test('a blurb folds to one line, and only a blurb that overflows gets a toggle', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    const [a] = await twoDemos(page);
    await page.getByTestId(`song-demo-${a}`).click();
    await page.getByTestId('demo-loaded-info').click();
    await expect(page.getByTestId('demo-library')).toBeVisible();

    // Measured in a real layout, folded — the rule the code applies, checked from
    // outside: every surviving toggle hides text, every dropped one hid none.
    await expect.poll(() => page.getByTestId('demo-library').evaluate((list) => {
      const out: string[] = [];
      for (const more of list.querySelectorAll<HTMLElement>('[data-testid="demo-library-more"]')) {
        const blurb = document.getElementById(more.getAttribute('aria-controls')!)!;
        if (more.getAttribute('aria-expanded') === 'true') continue; // the loaded one, unfolded
        if (blurb.scrollHeight <= blurb.clientHeight) out.push(`idle toggle: ${blurb.textContent}`);
      }
      for (const blurb of list.querySelectorAll<HTMLElement>('[id^="demo-library-blurb-"]')) {
        if (list.querySelector(`[aria-controls="${blurb.id}"]`)) continue;
        if (blurb.scrollHeight > blurb.clientHeight) out.push(`no toggle: ${blurb.textContent}`);
      }
      return out;
    })).toEqual([]);
    expect(await page.getByTestId('demo-library-more').count()).toBeGreaterThan(0);

    // Pinned by what it controls: an `aria-expanded="false"` locator would move on
    // to the next folded toggle the moment this one unfolds.
    const controls = await page.locator('[data-testid="demo-library-more"][aria-expanded="false"]')
      .first().getAttribute('aria-controls');
    const folded = page.locator(`[data-testid="demo-library-more"][aria-controls="${controls}"]`);
    await folded.click();
    await expect(folded).toHaveAttribute('aria-expanded', 'true');
    await expect(folded).toHaveText('Less');
  });

  test('Undo brings the ⓘ back to the demo it named, and New takes it away', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    const [a, b] = await twoDemos(page);

    await page.getByTestId(`song-demo-${a}`).click();
    await expect.poll(() => nextAfter(page, a)).toBe('demo-loaded-info');
    await page.getByTestId(`song-demo-${b}`).click();
    await expect.poll(() => nextAfter(page, b)).toBe('demo-loaded-info');

    await page.getByTestId('toast-action').click(); // Undo the second load
    await expect.poll(() => nextAfter(page, a)).toBe('demo-loaded-info');

    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('demo-loaded-info')).toHaveCount(0);
  });

  test('ⓘ mode badges the row once and reaches the library without loading', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    const [a] = await twoDemos(page);
    await page.getByTestId('info-badges').click();
    // A badge below the fold is hidden until scrolled to (onboarding.md REQ-a-badge-shows-only-where-reachable).
    await page.locator('[data-help="song.demos"]').scrollIntoViewIfNeeded();

    const badge = page.getByTestId('info-badge-song.demos');
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page.getByTestId('demo-library')).toBeVisible();
    // Reading is free: nothing loaded, so no demo wears the ⓘ.
    await expect(page.getByTestId('demo-loaded-info')).toHaveCount(0);

    await entryFor(page, a).getByTestId('demo-library-load').click();
    await expect(page.getByTestId('demo-library')).toHaveCount(0);
    await expect.poll(() => nextAfter(page, a)).toBe('demo-loaded-info');
    await expect(page.getByTestId('song-slot-select').locator('button').first()).toContainText(a);

    // v5: the badge's door knows what is loaded too — read at this click, so the
    // demo loaded while the badges were already on is the one marked.
    await badge.click();
    const marked = page.locator('[data-testid="demo-library-entry"][aria-current="true"]');
    await expect(marked).toHaveCount(1);
    await expect(marked.getByRole('heading')).toHaveText(a);
    await expect(marked.getByTestId('demo-library-load')).toHaveText('Loaded');
    await expect(marked.getByTestId('demo-library-load')).toBeDisabled();
    const more = marked.getByTestId('demo-library-more');
    if (await more.count() > 0) await expect(more).toHaveAttribute('aria-expanded', 'true');
  });
});
