// Applying the UI scale, its helpers, and the Settings row (specs/features/ui-scale.md).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';

const SHIPPED = 'width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no';
const TOUCH = '(hover: none) and (pointer: coarse)';

/** A matchMedia where exactly these queries match. */
function stubMedia(...on: string[]): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    media: q,
    matches: on.includes(q),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function resetDom(): void {
  document.head.innerHTML = `<meta name="viewport" content="${SHIPPED}">`;
  const html = document.documentElement;
  html.removeAttribute('style');
  delete html.dataset.uiBaseDpr;
  document.body.innerHTML = '';
}

const viewport = () => document.querySelector('meta[name="viewport"]')!.getAttribute('content');
const html = () => document.documentElement;

/** Fresh copies: `ui/ui-scale.ts` keeps the applied scale and its engine. */
async function fresh() {
  vi.resetModules();
  const ui = await import('../../src/ui/ui-scale');
  const state = await import('../../src/state/ui-scale');
  return { ui, state };
}

let store: Map<string, string>;
beforeEach(() => {
  store = installLocalStorageMock();
  resetDom();
  stubMedia();
  vi.stubGlobal('devicePixelRatio', 2);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetDom();
});

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('100% applies nothing (REQ-a-hundred-percent-is-a-no-op)', () => {
  it('boots with nothing stored and touches nothing', async () => {
    const { ui } = await fresh();
    const seen = vi.fn();
    ui.onUiScaleChange(seen);
    ui.initUiScale();
    expect(html().hasAttribute('style')).toBe(false);
    expect(html().dataset.uiBaseDpr).toBeUndefined();
    expect(viewport()).toBe(SHIPPED);
    expect(ui.currentUiScale()).toBe(100);
    expect(seen).not.toHaveBeenCalled();
  });

  it('has helpers that return their input', async () => {
    const { ui } = await fresh();
    ui.initUiScale();
    const r = rect(10, 20, 30, 40);
    expect(ui.cssZoom()).toBe(1);
    expect(ui.toLocal(123.5)).toBe(123.5);
    expect(ui.localRect(r)).toBe(r);
    expect(ui.backingScale()).toBe(2);
  });

  it('returns to exactly the shipped state from any other scale, on both engines', async () => {
    for (const touch of [false, true]) {
      resetDom();
      if (touch) stubMedia(TOUCH); else stubMedia();
      const { ui } = await fresh();
      ui.initUiScale();
      ui.applyUiScale(150);
      ui.applyUiScale(100);
      expect(html().hasAttribute('style'), `touch ${touch}`).toBe(false);
      expect(html().dataset.uiBaseDpr, `touch ${touch}`).toBeUndefined();
      expect(viewport(), `touch ${touch}`).toBe(SHIPPED);
      expect(ui.cssZoom()).toBe(1);
    }
  });
});

describe('the zoom engine (REQ-one-value-two-engines)', () => {
  it('zooms <html> and exposes --ui-zoom, leaving the viewport alone', async () => {
    const { ui } = await fresh();
    ui.initUiScale();
    ui.applyUiScale(150);
    expect(html().style.getPropertyValue('zoom')).toBe('1.5');
    expect(html().style.getPropertyValue('--ui-zoom')).toBe('1.5');
    expect(viewport()).toBe(SHIPPED);
    expect(ui.cssZoom()).toBe(1.5);
  });

  it('converts viewport coordinates to local px (REQ-coordinates-are-converted-at-the-read)', async () => {
    const { ui } = await fresh();
    ui.initUiScale();
    ui.applyUiScale(150);
    vi.stubGlobal('innerWidth', 1500);
    vi.stubGlobal('innerHeight', 900);
    expect(ui.toLocal(150)).toBe(100);
    expect(ui.localRect(rect(150, 300, 75, 30))).toMatchObject({ left: 100, top: 200, width: 50, height: 20, right: 150, bottom: 220 });
    expect(ui.viewportWidth()).toBe(1000);
    expect(ui.viewportHeight()).toBe(600);
  });

  it('drops the containment for one layout on every live change, so Firefox re-asks its queries (regression, REQ-breakpoints-follow-the-effective-width)', async () => {
    const { ui } = await fresh();
    ui.initUiScale();
    // Record the attribute at the moment layout is forced (offsetWidth is read).
    const seen: (string | undefined)[] = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this === document.documentElement) seen.push(this.dataset.uiRequery);
        return desc.get!.call(this);
      },
    });
    try {
      for (const s of [150, 67, 100]) {
        seen.length = 0;
        ui.applyUiScale(s);
        expect(seen, `${s}`).toContain('');
        expect(html().hasAttribute('data-ui-requery'), `${s}`).toBe(false);
      }
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', desc);
    }
    expect(html().hasAttribute('style')).toBe(false); // back at 100: nothing left behind
  });

  it('forces no layout at boot, where every engine already answers the queries right', async () => {
    store.set('websynth.ui.scale', '150');
    const { ui } = await fresh();
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    const read = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) { read(); return desc.get!.call(this); },
    });
    try {
      ui.initUiScale();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', desc);
    }
    expect(html().style.getPropertyValue('zoom')).toBe('1.5');
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps canvases sharp: devicePixelRatio does not include CSS zoom (REQ-canvases-stay-sharp-at-any-scale)', async () => {
    const { ui } = await fresh();
    ui.initUiScale();
    ui.applyUiScale(150);
    expect(ui.backingScale()).toBe(3);
  });
});

describe('the viewport engine (REQ-one-value-two-engines)', () => {
  beforeEach(() => stubMedia(TOUCH));

  it('rewrites the viewport tag and zooms nothing', async () => {
    const { ui, state } = await fresh();
    ui.initUiScale();
    ui.applyUiScale(80);
    expect(viewport()).toBe(state.scaledViewport(80));
    expect(html().style.getPropertyValue('zoom')).toBe('');
    expect(ui.cssZoom()).toBe(1);
  });

  it('sizes canvases from the ratio captured before the rewrite, whatever the engine reports after (REQ-canvases-stay-sharp-at-any-scale)', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const { ui } = await fresh();
    ui.initUiScale();
    ui.applyUiScale(80);
    expect(html().dataset.uiBaseDpr).toBe('3');
    expect(ui.backingScale()).toBeCloseTo(2.4);
    vi.stubGlobal('devicePixelRatio', 2.4); // WebKit folds the page scale in; Chromium does not
    expect(ui.backingScale()).toBeCloseTo(2.4);
  });

  it('adopts the ratio the boot script captured', async () => {
    store.set('websynth.ui.scale', '125');
    html().dataset.uiBaseDpr = '3';
    vi.stubGlobal('devicePixelRatio', 3.75);
    const { ui } = await fresh();
    ui.initUiScale();
    expect(ui.backingScale()).toBeCloseTo(3.75);
  });
});

describe('a change re-lays out like a resize (REQ-a-scale-change-is-a-resize)', () => {
  it('runs each listener once and dispatches one resize, and ignores a repeat', async () => {
    const { ui } = await fresh();
    ui.initUiScale();
    const seen = vi.fn();
    const resized = vi.fn();
    const off = ui.onUiScaleChange(seen);
    window.addEventListener('resize', resized);
    try {
      ui.applyUiScale(125);
      ui.applyUiScale(125);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(resized).toHaveBeenCalledTimes(1);
      off();
      ui.applyUiScale(150);
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('resize', resized);
    }
  });

  it('ignores a value that is not a stop (edge)', async () => {
    const { ui } = await fresh();
    ui.initUiScale();
    ui.applyUiScale(120);
    expect(ui.currentUiScale()).toBe(100);
    expect(html().hasAttribute('style')).toBe(false);
  });

  it('keeps going when a listener throws', async () => {
    const { ui } = await fresh();
    ui.initUiScale();
    const after = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    ui.onUiScaleChange(() => { throw new Error('boom'); });
    ui.onUiScaleChange(after);
    ui.applyUiScale(125);
    expect(after).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('script breakpoints follow the effective width (REQ-js-breakpoints-follow-the-effective-width)', () => {
  it('a 1366 px window at 150% is compact; at 100% it asks matchMedia as before', async () => {
    vi.stubGlobal('innerWidth', 1366);
    const { ui } = await fresh();
    const { isCompact, isPhone } = await import('../../src/ui/viewport');
    ui.initUiScale();
    expect(isCompact()).toBe(false); // matchMedia says no
    ui.applyUiScale(150);
    expect(isCompact()).toBe(true); // 1366 / 1.5 = 911
    expect(isPhone()).toBe(false);
    ui.applyUiScale(50);
    expect(isCompact()).toBe(false);
  });
});

describe('a menu lands under its toggle when zoomed (REQ-coordinates-are-converted-at-the-read)', () => {
  it('writes local px, so the rendered menu sits 6 local px under the toggle', async () => {
    const { ui } = await fresh();
    const { anchorMenu } = await import('../../src/ui/components/menu-anchor');
    ui.initUiScale();
    ui.applyUiScale(150);
    vi.stubGlobal('innerHeight', 900);
    const toggle = document.createElement('button');
    const menu = document.createElement('div');
    toggle.getBoundingClientRect = () => rect(300, 150, 90, 30);
    anchorMenu(toggle, menu, 'toggle');
    expect(menu.style.left).toBe('200px');
    expect(menu.style.top).toBe('126px'); // (150 + 30) / 1.5 + 6
    expect(menu.style.minWidth).toBe('60px');
  });
});

describe('the Settings row (REQ-the-slider-commits-on-release)', () => {
  it('previews while dragging, commits on release, and resets', async () => {
    const { ui, state } = await fresh();
    const { createUiScaleControl } = await import('../../src/ui/components/ui-scale-control');
    ui.initUiScale();
    const control = createUiScaleControl();
    document.body.appendChild(control.el);
    const q = (id: string) => control.el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const slider = q('ui-scale-slider') as HTMLInputElement;
    const readout = q('ui-scale-value');
    const reset = q('ui-scale-reset') as HTMLButtonElement;

    expect(readout.textContent).toBe('100%');
    expect(reset.disabled).toBe(true);
    expect(Number(slider.min)).toBe(0);
    expect(Number(slider.max)).toBe(state.UI_SCALE_STOPS.length - 1);

    slider.value = String(state.UI_SCALE_STOPS.indexOf(125));
    slider.dispatchEvent(new Event('input'));
    expect(readout.textContent).toBe('125%');
    expect(store.has('websynth.ui.scale')).toBe(false);
    expect(ui.currentUiScale()).toBe(100);

    slider.dispatchEvent(new Event('change'));
    expect(store.get('websynth.ui.scale')).toBe('125');
    expect(ui.currentUiScale()).toBe(125);
    expect(reset.disabled).toBe(false);

    reset.click();
    expect(store.has('websynth.ui.scale')).toBe(false);
    expect(ui.currentUiScale()).toBe(100);
    expect(slider.value).toBe(String(state.UI_SCALE_STOPS.indexOf(100)));
    expect(readout.textContent).toBe('100%');
    expect(reset.disabled).toBe(true);
    control.destroy();
  });

  it('opens on the applied scale', async () => {
    store.set('websynth.ui.scale', '67');
    const { ui } = await fresh();
    const { createUiScaleControl } = await import('../../src/ui/components/ui-scale-control');
    ui.initUiScale();
    const control = createUiScaleControl();
    expect(control.el.querySelector('[data-testid="ui-scale-value"]')!.textContent).toBe('67%');
    control.destroy();
  });
});
