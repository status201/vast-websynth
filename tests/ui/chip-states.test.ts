// @vitest-environment node
//
// Reads the stylesheet as text, so it runs in node — the same reason
// tests/ui/typography.test.ts does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A chain chip carries three independent facts and must spend one visual
 * channel on each — specs/features/arrangement.md REQ-12.
 *
 * This is a source pin, not a render test, for the reason
 * tests/ui/typography.test.ts gives: the jsdom suite never resolves CSS
 * Modules, so nothing in it can observe a cascade. The defect being pinned was
 * itself invisible to every runtime test — `.sel` and `[data-transposed]`
 * declared the SAME property with the SAME specificity, so the later rule won
 * silently and a transposed chip could not show that it was selected. What a
 * test can check is exactly what went wrong: which property each state claims,
 * and which order they are declared in.
 */

const CSS_PATH = fileURLToPath(new URL('../../src/ui/styles/song-panel.module.css', import.meta.url));
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block of the first rule whose selector contains `needle`. */
function block(needle: string): string {
  const at = css.indexOf(needle);
  expect(at, `no rule matching ${needle}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

const TRANSPOSED = ".chip[data-transposed='true'] {";
const SELECTED = '.chip:global(.sel)';
const PLAYING = '.chip:global(.playing)';

describe('chain chip visual channels (REQ-12)', () => {
  it('gives the transposed state its own channel, not the selection border', () => {
    const b = block(TRANSPOSED);
    expect(b).toMatch(/color:\s*var\(--accent-good\)/);
    // The regression itself: this rule used to claim border-color too, which is
    // the selection's channel.
    expect(b).not.toMatch(/border-color/);
  });

  it('keeps the selection on the border alone', () => {
    expect(block(SELECTED)).toMatch(/border-color:\s*var\(--accent-secondary\)/);
  });

  it('declares the transient states after the intrinsic one, so they layer', () => {
    // Equal specificity is decided by source order — the tie that produced the
    // bug. Selection and playing must come last or a transposed chip swallows
    // them again.
    expect(css.indexOf(TRANSPOSED)).toBeLessThan(css.indexOf(SELECTED));
    expect(css.indexOf(SELECTED)).toBeLessThan(css.indexOf(PLAYING));
  });

  it('lets playing win the fill on a transposed chip too', () => {
    // Otherwise the green wash outranks it: [data-transposed] is 0-2-0 and a
    // lone :global(.playing) class is 0-2-0 as well.
    expect(css).toContain(".chip[data-transposed='true']:global(.playing)");
  });

  it('draws the drop marker without the drag ever touching layout', () => {
    // An inserted element would reflow a wrapping row under the pointer, so the
    // marker is an edge pseudo-element on the neighbouring chip (REQ-11).
    expect(css).toMatch(/\.chip\[data-drag-over\]::after/);
    expect(block('.chip {')).toMatch(/position:\s*relative/);
  });
});
