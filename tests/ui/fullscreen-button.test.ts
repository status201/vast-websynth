import { describe, it, expect, vi } from 'vitest';
import { createFullscreenButton } from '../../src/ui/components/fullscreen-button';
import { HEADER_ICONS } from '../../src/ui/components/header-icons';
import tourStyles from '../../src/ui/styles/tour.module.css';

/**
 * jsdom has no Fullscreen API, so the supported path runs against a stub
 * "document" — the component only touches fullscreenEnabled/fullscreenElement,
 * documentElement.requestFullscreen, exitFullscreen, addEventListener and
 * defaultView (matchMedia + resize) (buttons themselves come from the real
 * global document).
 */
type Listeners = Record<string, Array<() => void>>;
const on = (listeners: Listeners) =>
  vi.fn((type: string, cb: () => void) => {
    (listeners[type] ??= []).push(cb);
  });

function makeFullscreenDoc({ displayModeFullscreen = false } = {}) {
  const listeners: Listeners = {};
  const mqlListeners: Listeners = {};
  const winListeners: Listeners = {};
  const displayMode = {
    matches: displayModeFullscreen,
    addEventListener: on(mqlListeners),
    fire: (type: string) => mqlListeners[type]?.forEach((cb) => cb()),
  };
  const doc = {
    fullscreenEnabled: true,
    fullscreenElement: null as Element | null,
    documentElement: {
      requestFullscreen: vi.fn(async () => {}),
    },
    exitFullscreen: vi.fn(async () => {}),
    addEventListener: on(listeners),
    fire: (type: string) => listeners[type]?.forEach((cb) => cb()),
    defaultView: {
      matchMedia: vi.fn(() => displayMode),
      addEventListener: on(winListeners),
      fire: (type: string) => winListeners[type]?.forEach((cb) => cb()),
    },
    displayMode,
  };
  return doc;
}

// innerHTML re-serializes the parsed SVG, so normalize the expected
// string through the same parser before comparing.
const norm = (svg: string) => {
  const d = document.createElement('div');
  d.innerHTML = svg;
  return d.innerHTML;
};

function expectState(btn: HTMLButtonElement, fullscreen: boolean) {
  expect(btn.classList.contains('on')).toBe(fullscreen);
  // The orange active glow — same treatment as the ⓘ info-badges button.
  expect(btn.classList.contains(tourStyles.toggleActive!)).toBe(fullscreen);
  expect(btn.getAttribute('aria-pressed')).toBe(String(fullscreen));
  expect(btn.innerHTML).toBe(norm(fullscreen ? HEADER_ICONS.compress : HEADER_ICONS.expand));
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
    const doc = makeFullscreenDoc();
    const btn = createFullscreenButton(doc as unknown as Document)!;
    expectState(btn, false);
    expect(btn.title).toBe('Toggle fullscreen');
    expect(btn.getAttribute('aria-label')).toBe('Toggle fullscreen');

    doc.fullscreenElement = document.createElement('div');
    doc.fire('fullscreenchange');
    expectState(btn, true);

    doc.fullscreenElement = null;
    doc.fire('fullscreenchange');
    expectState(btn, false);
  });

  it('still works where matchMedia is missing (element fullscreen only)', () => {
    const doc = makeFullscreenDoc();
    (doc.defaultView as { matchMedia?: unknown }).matchMedia = undefined;
    const btn = createFullscreenButton(doc as unknown as Document)!;
    expectState(btn, false);
    btn.click();
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  // pwa-install.md REQ-manifest-and-button-drive-fullscreen v6 (regression): the
  // installed Android app launches fullscreen with no fullscreenElement.
  it('is already on when the window was launched fullscreen', () => {
    const doc = makeFullscreenDoc({ displayModeFullscreen: true });
    const btn = createFullscreenButton(doc as unknown as Document)!;
    expect(doc.defaultView.matchMedia).toHaveBeenCalledWith('(display-mode: fullscreen)');
    expectState(btn, true);
  });

  it('one tap leaves window-level fullscreen: request, then exit', async () => {
    const doc = makeFullscreenDoc({ displayModeFullscreen: true });
    const btn = createFullscreenButton(doc as unknown as Document)!;

    btn.click();
    await vi.waitFor(() => expect(doc.exitFullscreen).toHaveBeenCalledTimes(1));
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.documentElement.requestFullscreen.mock.invocationCallOrder[0]!).toBeLessThan(
      doc.exitFullscreen.mock.invocationCallOrder[0]!,
    );
  });

  it('a failed request in window-level fullscreen is swallowed and skips the exit', async () => {
    const doc = makeFullscreenDoc({ displayModeFullscreen: true });
    doc.documentElement.requestFullscreen.mockRejectedValueOnce(new Error('denied'));
    const btn = createFullscreenButton(doc as unknown as Document)!;

    btn.click();
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    // Let the whole promise chain settle (a macrotask outlasts every microtask).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it('follows the display-mode query and window resize', () => {
    const doc = makeFullscreenDoc();
    const btn = createFullscreenButton(doc as unknown as Document)!;
    expectState(btn, false);

    doc.displayMode.matches = true;
    doc.displayMode.fire('change');
    expectState(btn, true);

    doc.displayMode.matches = false;
    doc.defaultView.fire('resize');
    expectState(btn, false);
  });

  it('an unchanged sync writes nothing to the button', () => {
    const doc = makeFullscreenDoc();
    const btn = createFullscreenButton(doc as unknown as Document)!;
    const setAttribute = vi.spyOn(btn, 'setAttribute');
    doc.defaultView.fire('resize');
    doc.fire('fullscreenchange');
    expect(setAttribute).not.toHaveBeenCalled();
  });
});
