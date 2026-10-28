import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * keyboard-range.md REQ-the-key-size-ignores-the-page-scrollbar (regression).
 *
 * Playwright hides scrollbars by default, which is exactly what hid this bug:
 * with them hidden the page width never changes, so nothing can feed back. This
 * file turns real ones back on. It is a file of its own because launch options
 * are per worker, and Playwright refuses them inside a `describe`.
 */
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('the page scrollbar cannot make the keyboard wiggle', async ({ page }) => {
  // The reported layout: the scope dragged to its 260px maximum, Machines and
  // the EQ folded, FX open. At 1920x1080 it overflowed by 0.2px, and the
  // keyboard then alternated 169.2px / 168.0px every frame as the scrollbar
  // came and went.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.ui.scope.height', '260');
      localStorage.setItem('websynth.ui.collapsed.fx', '0');
      localStorage.setItem('websynth.ui.collapsed.pattern', '1');
      localStorage.setItem('websynth.ui.collapsed.eq', '1');
    } catch { /* ignore */ }
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await gotoAndStart(page);

  const frames = await page.evaluate(async () => {
    const wrap = document.querySelector('[data-testid="keyboard"]') as HTMLElement;
    const out: { kb: number; gutter: number }[] = [];
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      out.push({
        kb: wrap.getBoundingClientRect().height,
        // The body is the scroller (base.css), so its scrollbar is the one that
        // toggled; the viewport's is read too in case that ever changes.
        gutter: Math.max(document.body.offsetWidth - document.body.clientWidth,
          innerWidth - document.documentElement.clientWidth),
      });
    }
    return out;
  });
  const heights = [...new Set(frames.map((f) => f.kb.toFixed(2)))];
  expect(heights, 'one keyboard height on every frame').toHaveLength(1);
  // Whichever state it settles in, it holds. In this layout that is a steady
  // scrollbar over ~1px of real overflow (keyboard-range.md "What it settles to").
  const gutters = [...new Set(frames.map((f) => f.gutter))];
  expect(gutters, 'the scrollbar is shown on every frame or on none').toHaveLength(1);
});
