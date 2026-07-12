import { describe, it, expect, vi } from 'vitest';
import { createFullscreenButton } from '../../src/ui/components/fullscreen-button';

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

  it('reflects fullscreen state (on class + label) from fullscreenchange', () => {
    const doc = makeFullscreenDoc();
    const btn = createFullscreenButton(doc as unknown as Document)!;
    expect(btn.classList.contains('on')).toBe(false);
    expect(btn.textContent).toBe('Full');

    doc.fullscreenElement = document.createElement('div');
    doc.fire('fullscreenchange');
    expect(btn.classList.contains('on')).toBe(true);
    expect(btn.textContent).toBe('Exit');

    doc.fullscreenElement = null;
    doc.fire('fullscreenchange');
    expect(btn.classList.contains('on')).toBe(false);
    expect(btn.textContent).toBe('Full');
  });
});
