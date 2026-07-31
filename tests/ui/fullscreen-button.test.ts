import { describe, it, expect, vi } from 'vitest';
import { createFullscreenButton } from '../../src/ui/components/fullscreen-button';
import { HEADER_ICONS } from '../../src/ui/components/header-icons';
import tourStyles from '../../src/ui/styles/tour.module.css';

/**
 * jsdom has no Fullscreen API, so the supported path runs against a stub
 * "document" — the component only touches fullscreenEnabled/fullscreenElement,
 * documentElement.requestFullscreen, exitFullscreen and addEventListener
 * (buttons themselves come from the real global document).
 */
function makeFullscreenDoc() {
  const listeners: Record<string, Array<() => void>> = {};
  const doc = {
    fullscreenEnabled: true,
    fullscreenElement: null as Element | null,
    documentElement: {
      requestFullscreen: vi.fn(async () => {}),
    },
    exitFullscreen: vi.fn(async () => {}),
    addEventListener: vi.fn((type: string, cb: () => void) => {
      (listeners[type] ??= []).push(cb);
    }),
    fire: (type: string) => listeners[type]?.forEach((cb) => cb()),
  };
  return doc;
}

describe('createFullscreenButton', () => {
  it('returns null when the Fullscreen API is unavailable (jsdom default)', () => {
    expect(createFullscreenButton(document)).toBeNull();
  });

  it('requests fullscreen when not fullscreen, exits when fullscreen', () => {
    const doc = makeFullscreenDoc();
    const btn = createFullscreenButton(doc as unknown as Document)!;
    expect(btn).not.toBeNull();
    expect(btn.dataset.testid).toBe('fullscreen');

    btn.click();
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.exitFullscreen).not.toHaveBeenCalled();

    doc.fullscreenElement = document.createElement('div');
    btn.click();
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('reflects fullscreen state (on class + icon) from fullscreenchange', () => {
    // innerHTML re-serializes the parsed SVG, so normalize the expected
    // string through the same parser before comparing.
    const norm = (svg: string) => {
      const d = document.createElement('div');
      d.innerHTML = svg;
      return d.innerHTML;
    };
    const doc = makeFullscreenDoc();
    const btn = createFullscreenButton(doc as unknown as Document)!;
    expect(btn.classList.contains('on')).toBe(false);
    expect(btn.classList.contains(tourStyles.toggleActive!)).toBe(false);
    expect(btn.innerHTML).toBe(norm(HEADER_ICONS.expand));
    expect(btn.title).toBe('Toggle fullscreen');
    expect(btn.getAttribute('aria-label')).toBe('Toggle fullscreen');

    doc.fullscreenElement = document.createElement('div');
    doc.fire('fullscreenchange');
    expect(btn.classList.contains('on')).toBe(true);
    // The orange active glow — same treatment as the ⓘ info-badges button.
    expect(btn.classList.contains(tourStyles.toggleActive!)).toBe(true);
    expect(btn.innerHTML).toBe(norm(HEADER_ICONS.compress));

    doc.fullscreenElement = null;
    doc.fire('fullscreenchange');
    expect(btn.classList.contains('on')).toBe(false);
    expect(btn.classList.contains(tourStyles.toggleActive!)).toBe(false);
    expect(btn.innerHTML).toBe(norm(HEADER_ICONS.expand));
  });
});
