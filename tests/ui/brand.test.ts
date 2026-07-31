import { describe, it, expect } from 'vitest';
import { createBrand } from '../../src/ui/components/brand';
import brandStyles from '../../src/ui/styles/brand.module.css';
import layoutStyles from '../../src/ui/styles/layout.module.css';

/**
 * The shared brand block (specs/features/brand.md). Before it existed, the
 * header drew the real faceplate while the About and start modals each
 * hand-rolled a flattened lookalike — so what these tests protect is that the
 * block stays one thing with no per-surface variants.
 */
describe('brand block (brand.md)', () => {
  it('renders VAST + a boxed G1-J5 + the tagline (REQ-1)', () => {
    const el = createBrand();
    expect(el.classList.contains(brandStyles.brand!)).toBe(true);

    const row = el.querySelector(`.${brandStyles.brandRow!}`);
    expect(row).not.toBeNull();
    expect(row!.querySelector(`.${brandStyles.brandName!}`)?.textContent).toBe('VAST');
    expect(row!.querySelector(`.${brandStyles.brandModel!}`)?.textContent).toBe('G1-J5');

    const tagline = el.querySelector(`.${brandStyles.brandTagline!}`);
    expect(tagline?.textContent).toBe('Vast Audio Synthesis Technology');
    // Tagline below the row, not beside it.
    expect(el.children[0]).toBe(row);
    expect(el.children[1]).toBe(tagline);
  });

  it('gives every caller the same markup — there is no variant (REQ-1)', () => {
    expect(createBrand().outerHTML).toBe(createBrand().outerHTML);
  });

  it('carries no header framing of its own (REQ-3)', () => {
    // The divider rule to the right of the header's block is composed on at
    // that call site; baked in here it would draw a stray vertical line down
    // the inside of the About and start modal cards.
    const el = createBrand();
    expect(el.classList.contains(layoutStyles.headerBrand!)).toBe(false);
    expect(layoutStyles.headerBrand).toBeTruthy(); // the class still exists
  });
});
