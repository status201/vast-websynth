import { describe, it, expect } from 'vitest';
import { iconLabel, iconTextEl, UI_ICONS } from '../../src/ui/components/ui-icons';

/**
 * The two icon + text builders — iconography.md "Contract".
 *
 * The spec promises they "emit the same `.icon-label` span, so the two look
 * identical". The spacing between glyph and text comes from one global rule,
 * `svg.ui-icon + .icon-label` (base.css), which only matches *direct* siblings —
 * so "identical" is a claim about DOM shape, and that is what is pinned here.
 * `iconTextEl` once wrapped its svg in a span, and every caller lost the gap.
 */

/** Tag sequence of a node's children, e.g. `['svg', 'span.icon-label']`. */
function shape(el: Element): string[] {
  return [...el.children].map((c) =>
    c.classList.contains('icon-label') ? `${c.tagName.toLowerCase()}.icon-label` : c.tagName.toLowerCase());
}

describe('iconTextEl matches iconLabel (iconography.md v2, regression)', () => {
  it.each(['before', 'after'] as const)('puts the svg and label side by side (%s)', (pos) => {
    const fromMarkup = document.createElement('span');
    fromMarkup.innerHTML = iconLabel('check', 'Linked', pos);
    const fromNodes = iconTextEl('check', 'Linked', pos);
    expect(shape(fromNodes)).toEqual(shape(fromMarkup));
    expect(shape(fromNodes)).toEqual(pos === 'before' ? ['svg', 'span.icon-label'] : ['span.icon-label', 'svg']);
  });

  it('is the glyph the set defines, still aria-hidden', () => {
    const el = iconTextEl('bulb', 'hint');
    const expected = document.createElement('span');
    expected.innerHTML = UI_ICONS.bulb;
    expect(el.querySelector('svg')!.outerHTML).toBe(expected.firstElementChild!.outerHTML);
    expect(el.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps derived text a text node', () => {
    const el = iconTextEl('bulb', '<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
