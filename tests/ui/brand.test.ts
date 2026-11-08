import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBrand } from '../../src/ui/components/brand';
import brandStyles from '../../src/ui/styles/brand.module.css';
import headerStyles from '../../src/ui/styles/header.module.css';

/**
 * The shared brand block (specs/features/brand.md). Before it existed, the
 * header drew the real faceplate while the About and start modals each
 * hand-rolled a flattened lookalike — so what these tests protect is that the
 * block stays one thing with no per-surface variants.
 */
describe('brand block (brand.md)', () => {
  it('renders VAST + a boxed G1-J8 + the tagline (REQ-brand-block-has-no-variants)', () => {
    const el = createBrand();
    expect(el.classList.contains(brandStyles.brand!)).toBe(true);

    const row = el.querySelector(`.${brandStyles.brandRow!}`);
    expect(row).not.toBeNull();
    expect(row!.querySelector(`.${brandStyles.brandName!}`)?.textContent).toBe('VAST');
    expect(row!.querySelector(`.${brandStyles.brandModel!}`)?.textContent).toBe('G1-J8');

    const tagline = el.querySelector(`.${brandStyles.brandTagline!}`);
    expect(tagline?.textContent).toBe('Vast Audio Synthesis Technology');
    // Tagline below the row, not beside it.
    expect(el.children[0]).toBe(row);
    expect(el.children[1]).toBe(tagline);
  });

  it('gives every caller the same markup — there is no variant (REQ-brand-block-has-no-variants)', () => {
    expect(createBrand().outerHTML).toBe(createBrand().outerHTML);
  });

  it('carries no header framing of its own (REQ-brand-block-carries-no-framing)', () => {
    // The divider rule to the right of the header's block is composed on at
    // that call site; baked in here it would draw a stray vertical line down
    // the inside of the About and start modal cards.
    const el = createBrand();
    expect(el.classList.contains(headerStyles.headerBrand!)).toBe(false);
    expect(headerStyles.headerBrand).toBeTruthy(); // the class still exists
  });

  // jsdom lays out no text, so these pin what keeps the width, not the width.
  describe("Pastel's logo on every platform (regression)", () => {
    const pastel = readFileSync(path.join(process.cwd(), 'src/styles/themes/pastel.css'), 'utf8');
    const brandCss = readFileSync(path.join(process.cwd(), 'src/ui/styles/brand.module.css'), 'utf8');

    it('tracks the tagline alike in every theme (REQ-the-tagline-spans-the-badge-row)', () => {
      const rule = /\.brandTagline\s*\{([^}]*)\}/.exec(brandCss)![1]!;
      expect(rule).toMatch(/letter-spacing:\s*0\.15em/);
    });

    it('sets VAST bold, because 900 is Arial Black on Windows (REQ-the-name-weight-stays-in-the-family)', () => {
      expect(/\.brandName\s*\{([^}]*)\}/.exec(brandCss)![1]).toContain('var(--brand-name-weight, 900)');
      expect(pastel).toMatch(/--brand-name-weight:\s*700;/);
    });

    it('reaches a narrow face on each platform before a normal-width one (REQ-pastel-names-a-narrow-face-per-platform)', () => {
      const stack = /--serif:([^;]*);/.exec(pastel)![1]!;
      const firstWide = stack.indexOf("'Helvetica Neue'");
      expect(firstWide).toBeGreaterThan(0);
      for (const narrow of ["'Arial Narrow'", "'Liberation Sans Narrow'", 'sans-serif-condensed', "'DejaVu Sans Condensed'"]) {
        const at = stack.indexOf(narrow);
        expect(at, narrow).toBeGreaterThanOrEqual(0);
        expect(at, narrow).toBeLessThan(firstWide);
      }
    });
  });
});
