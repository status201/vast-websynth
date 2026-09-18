import { describe, it, expect } from 'vitest';
import { createSectionTitle } from '../../src/ui/components/section-title';
import { UI_ICONS } from '../../src/ui/components/ui-icons';
import { readSource, cssDecl } from '../css-source';

/**
 * The heading on the FX, MACHINES and EQUALIZER bars — specs/features/section-title.md.
 *
 * The three sections used to style their own titles and disagreed on colour,
 * face and left edge. Most of what is worth pinning is therefore the stylesheet:
 * one rule, in the faceplate white, that no tab can borrow.
 */

/** A glyph as the DOM serialises it (`<path/>` comes back as `<path></path>`). */
function parsed(markup: string): string {
  const holder = document.createElement('span');
  holder.innerHTML = markup;
  return holder.firstElementChild!.outerHTML;
}

describe('createSectionTitle (REQ-one-component-draws-every-heading, REQ-heading-is-icon-then-text)', () => {
  it('is the icon, then the text', () => {
    const el = createSectionTitle({ text: 'Equalizer', icon: 'sliders' });
    const [glyph, label] = [...el.children];
    expect(glyph!.outerHTML).toBe(parsed(UI_ICONS.sliders));
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
    expect(label!.textContent).toBe('Equalizer');
    // The text is the whole accessible name: the drawing adds nothing to it.
    expect(el.textContent).toBe('Equalizer');
  });

  it('keeps the text a text node, never parsed as markup', () => {
    const el = createSectionTitle({ text: '<b>FX</b>', icon: 'waveBurst' });
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toBe('<b>FX</b>');
  });

  it('draws each section’s own glyph', () => {
    for (const icon of ['waveBurst', 'padMachine', 'sliders'] as const) {
      const el = createSectionTitle({ text: icon, icon });
      expect(el.firstElementChild!.outerHTML, icon).toBe(parsed(UI_ICONS[icon]));
    }
  });
});

describe('compact (REQ-compact-drops-text-not-icon)', () => {
  it('adds a second class and leaves the text in the DOM', () => {
    const plain = createSectionTitle({ text: 'Machines', icon: 'padMachine' });
    const compact = createSectionTitle({ text: 'Machines', icon: 'padMachine', compact: true });
    expect(compact.classList.length).toBe(plain.classList.length + 1);
    expect(compact.textContent).toBe('Machines');
  });

  it('hides the text visually, never with display:none, from 1140px down', () => {
    const css = readSource('src/ui/styles/section-title.module.css');
    const media = css.slice(css.indexOf('@media (max-width: 1140px)'));
    expect(media.length, 'the 1140px step exists').toBeLessThan(css.length);
    const hide = media.slice(0, media.indexOf('}'));
    expect(hide).toContain('.compact :global(.icon-label)');
    expect(hide).toContain('clip: rect(0 0 0 0)');
    expect(hide).not.toMatch(/display:\s*none/);
  });
});

describe('the heading look (REQ-heading-is-white-and-inert)', () => {
  const css = readSource('src/ui/styles/section-title.module.css');
  const tabsCss = readSource('src/ui/styles/tabs.module.css');
  const layoutCss = readSource('src/ui/styles/layout.module.css');

  it('is the faceplate white, undimmed and inert', () => {
    expect(cssDecl(css, '.root', 'color')).toBe('var(--text)');
    expect(cssDecl(css, '.root', 'opacity')).toBeNull();
    expect(cssDecl(css, '.root', 'pointer-events')).toBe('none');
    expect(cssDecl(css, '.root', 'font-family')).toBe('var(--serif)');
  });

  it('dims to --text-dim while its own section is folded (REQ-folded-heading-dims)', () => {
    // Child combinators, not a bare descendant: only the folded section's own
    // heading (section > bar > heading), never one nested under some other fold.
    expect(cssDecl(css, ':global(.collapsed) > :first-child > .root', 'color'))
      .toBe('var(--text-dim)');
    // Dim is still not a tab colour, so a folded heading cannot pass for a tab.
    expect(tabsCss).not.toMatch(/(^|[\s;{])color:\s*var\(--text-dim\)/m);
  });

  // REQ-folded-selected-tab-dims (v4) — the folded row's selected tab burns low, in its own hue.
  it("dims a folded row's selected tab to the dim yellow, and leaves the LEDs alone (REQ-folded-selected-tab-dims)", () => {
    const folded = '.root:global(.collapsed) > .bar > .tab:global(.active)';
    expect(cssDecl(tabsCss, folded, 'color')).toBe('var(--accent-secondary-dim)');
    expect(cssDecl(tabsCss, folded, 'text-shadow')).toBe('none');
    expect(cssDecl(tabsCss, folded, 'border-bottom-color')).not.toBeNull();
    // Open, it is still the bright yellow.
    expect(cssDecl(tabsCss, '.tab:global(.active)', 'color')).toBe('var(--accent-secondary)');
    // No fold rule reaches the lamp: it reports the machine, not the view.
    expect(tabsCss).not.toMatch(/collapsed[^{]*\.led/);
    // The token exists, and is a colour of its own rather than an alias of the heading's dim.
    const theme = readSource('src/styles/theme.css');
    expect(theme).toMatch(/--accent-secondary-dim:\s*#[0-9a-f]{6};/i);
    expect(theme).not.toMatch(/--accent-secondary-dim:\s*var\(--text-dim\)/);
  });

  it('is the only heading rule — no bar keeps a title of its own', () => {
    // A leftover per-bar title rule is how the three drifted apart before.
    expect(cssDecl(tabsCss, '.title', 'color')).toBeNull();
    expect(layoutCss).not.toContain('.fxSectionTitle');
    // …and no tab state (idle, active, the caret's hover) borrows the white.
    expect(tabsCss).not.toMatch(/(^|[\s;{])color:\s*var\(--text\)/m);
  });

  it('gives both kinds of bar the same padding, so the icons line up (REQ-heading-icons-share-one-x)', () => {
    expect(cssDecl(layoutCss, '.fxSectionBar', 'padding'))
      .toBe(cssDecl(tabsCss, '.bar', 'padding'));
  });

  it('insets the FX section by the same token as the tabbed rows (REQ-heading-icons-share-one-x)', () => {
    // A literal 22px equals the token only on desktop; below 992px it put the FX
    // icon 14px right of the other two.
    expect(cssDecl(layoutCss, '.fxSection', 'margin')).toBe('0 var(--side-margin)');
    expect(cssDecl(layoutCss, '.fxSection', 'margin'))
      .toBe(cssDecl(layoutCss, '.patternRow', 'margin'));
  });
});
