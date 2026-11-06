// The pre-paint half of the UI scale: public/theme-boot.js's second job
// (specs/features/ui-scale.md REQ-the-scale-applies-before-first-paint,
// REQ-the-boot-script-agrees-with-the-state).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import { readSource } from '../css-source';

const BOOT = readSource('public/theme-boot.js');
const boot = () => new Function(BOOT)();

const SHIPPED = 'width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no';
const TOUCH = '(hover: none) and (pointer: coarse)';

function stubMedia(...on: string[]): void {
  vi.stubGlobal('matchMedia', (q: string) => ({ media: q, matches: on.includes(q), addEventListener: () => {}, removeEventListener: () => {} }));
}

function resetDom(): void {
  document.head.innerHTML = `<meta name="viewport" content="${SHIPPED}">`;
  const html = document.documentElement;
  html.removeAttribute('style');
  delete html.dataset.uiBaseDpr;
  delete html.dataset.theme;
}

/** Everything either path may touch: the viewport tag and <html>'s scale state. */
function snapshot() {
  const html = document.documentElement;
  return {
    viewport: document.querySelector('meta[name="viewport"]')!.getAttribute('content'),
    zoom: html.style.getPropertyValue('zoom'),
    uiZoom: html.style.getPropertyValue('--ui-zoom'),
    baseDpr: html.dataset.uiBaseDpr ?? null,
  };
}

let store: Map<string, string>;
beforeEach(() => {
  store = installLocalStorageMock();
  resetDom();
  vi.stubGlobal('devicePixelRatio', 3);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetDom();
});

describe('the boot script agrees with the state (REQ-the-boot-script-agrees-with-the-state)', () => {
  it('leaves exactly the state applyUiScale leaves, for every stop on both engines', async () => {
    vi.resetModules();
    const { UI_SCALE_STOPS } = await import('../../src/state/ui-scale');
    for (const touch of [false, true]) {
      for (const stop of UI_SCALE_STOPS) {
        const at = `${stop}% ${touch ? 'touch' : 'desktop'}`;
        if (touch) stubMedia(TOUCH); else stubMedia();

        resetDom();
        store.clear();
        if (stop !== 100) store.set('websynth.ui.scale', String(stop));
        boot();
        const booted = snapshot();

        resetDom();
        store.clear();
        vi.resetModules();
        const ui = await import('../../src/ui/ui-scale');
        ui.initUiScale();
        ui.applyUiScale(stop);
        expect(booted, at).toEqual(snapshot());
      }
    }
  });
});

describe('100% applies nothing at boot (REQ-a-hundred-percent-is-a-no-op)', () => {
  it('leaves the page untouched with nothing, 100, or a forged value stored', () => {
    for (const touch of [false, true]) {
      if (touch) stubMedia(TOUCH); else stubMedia();
      for (const v of [null, '100', '120', 'abc', '9999', ' 125', '']) {
        resetDom();
        store.clear();
        if (v !== null) store.set('websynth.ui.scale', v);
        boot();
        expect(snapshot(), `${String(v)} touch ${touch}`).toEqual({ viewport: SHIPPED, zoom: '', uiZoom: '', baseDpr: null });
        expect(document.documentElement.hasAttribute('style')).toBe(false);
      }
    }
  });

  it('survives blocked storage and a missing matchMedia (edge)', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    vi.stubGlobal('matchMedia', undefined);
    expect(boot).not.toThrow();
    expect(document.documentElement.hasAttribute('style')).toBe(false);
  });

  it('zooms when a stop is stored and matchMedia is missing (the zoom engine is the fallback)', () => {
    vi.stubGlobal('matchMedia', undefined);
    store.set('websynth.ui.scale', '125');
    boot();
    expect(snapshot().zoom).toBe('1.25');
  });
});
