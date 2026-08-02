import { describe, it, expect, beforeEach } from 'vitest';
import { showValueBubble, hideValueBubble } from '../../src/ui/components/value-bubble';

const RECT = {
  left: 200, top: 300, width: 40, height: 64,
  right: 240, bottom: 364, x: 200, y: 300, toJSON() {},
} as DOMRect;

function anchor(rect: Partial<DOMRect> = {}): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  el.getBoundingClientRect = () => ({ ...RECT, ...rect }) as DOMRect;
  return el;
}

const bubble = (): HTMLElement | null =>
  document.querySelector('[data-testid="value-bubble"]');

/** motion-sequencer.md REQ-22 — the gesture-scoped half of the readout. */
describe('value bubble', () => {
  beforeEach(() => {
    hideValueBubble();
    document.body.innerHTML = '';
  });

  it('is absent until a gesture shows it, and gone again on hide', () => {
    expect(bubble()).toBeNull();
    showValueBubble(anchor(), '05 · 0.42');
    expect(bubble()?.textContent).toBe('05 · 0.42');
    hideValueBubble();
    expect(bubble()).toBeNull();
  });

  it('reuses one element across a drag instead of stacking them', () => {
    const a = anchor();
    showValueBubble(a, '0.40');
    const first = bubble();
    showValueBubble(a, '0.45');
    showValueBubble(a, '0.50');
    expect(document.querySelectorAll('[data-testid="value-bubble"]').length).toBe(1);
    expect(bubble()).toBe(first);
    expect(bubble()?.textContent).toBe('0.50');
  });

  it('sits above the anchor, horizontally centred on it', () => {
    showValueBubble(anchor(), '0.42');
    // jsdom has no layout, so the bubble measures 0x0: centred on the anchor
    // (200 + 40/2) and one gap above its top (300 - 0 - 6).
    expect(bubble()!.style.left).toBe('220px');
    expect(bubble()!.style.top).toBe('294px');
  });

  it('flips below the anchor when there is no room above it', () => {
    showValueBubble(anchor({ top: 2, bottom: 66 }), '0.42');
    expect(bubble()!.style.top).toBe('72px'); // bottom + gap
  });

  it('clamps to the viewport rather than running off the edge', () => {
    showValueBubble(anchor({ left: -30, right: 10, width: 40 }), '0.42');
    expect(bubble()!.style.left).toBe('4px'); // the margin, not -10
  });

  it('marks a peek so a read does not look like a write', () => {
    const a = anchor();
    showValueBubble(a, '0.42', { peek: true });
    const peekClass = bubble()!.className;
    showValueBubble(a, '0.42');
    expect(bubble()!.className).not.toBe(peekClass);
  });

  it('honours a caller-supplied testid', () => {
    showValueBubble(anchor(), '0.42', { testId: 'motion-value-bubble' });
    expect(document.querySelector('[data-testid="motion-value-bubble"]')).not.toBeNull();
  });
});
