// The Settings dialog's Theme row (specs/features/ui-themes.md REQ-choosing-a-theme-previews-it).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';

const sel = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** A fresh picker — `ui/theme.ts` keeps the choice in force, so each test gets new modules. */
async function mount() {
  vi.resetModules();
  const { createThemePicker } = await import('../../src/ui/components/theme-picker');
  const { THEMES } = await import('../../src/state/theme');
  const picker = createThemePicker();
  document.body.appendChild(picker.el);
  const tiles = [...picker.el.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  return { picker, tiles, THEMES };
}

/** A colour as jsdom writes it back, so a hex and the rgb() it becomes compare equal. */
const norm = (c: string) => { const p = document.createElement('span'); p.style.background = c; return p.style.background; };

const key = (el: HTMLElement, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

let store: Map<string, string>;
beforeEach(() => { store = installLocalStorageMock(); });
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  delete document.documentElement.dataset.theme;
});

describe('the theme picker', () => {
  it('offers Auto, then every shipped theme, as one radio group', async () => {
    const { tiles, THEMES } = await mount();
    expect(sel('theme-picker')!.getAttribute('role')).toBe('radiogroup');
    expect(tiles.map((t) => t.dataset.testid)).toEqual(['theme-auto', ...THEMES.map((t) => `theme-${t.id}`)]);
  });

  it('with no choice stored, selects the theme on the page (REQ-vibrant-is-the-default)', async () => {
    const { tiles } = await mount();
    const checked = tiles.filter((t) => t.getAttribute('aria-checked') === 'true');
    expect(checked.map((t) => t.dataset.testid)).toEqual(['theme-vibrant']);
    expect(store.has('websynth.ui.theme')).toBe(false);
  });

  it('starts on the stored choice, the only tile in the tab order', async () => {
    store.set('websynth.ui.theme', 'auto');
    const { tiles } = await mount();
    expect(tiles.map((t) => t.getAttribute('aria-checked'))).toEqual(tiles.map((_, i) => String(i === 0)));
    expect(tiles.map((t) => t.tabIndex)).toEqual(tiles.map((_, i) => (i === 0 ? 0 : -1)));
  });

  it('applies and stores a click at once, with no Apply step', async () => {
    const { tiles } = await mount();
    sel('theme-auto')!.click();
    expect(store.get('websynth.ui.theme')).toBe('auto');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(sel('theme-auto')!.getAttribute('aria-checked')).toBe('true');
    expect(tiles.filter((t) => t.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    sel('theme-dark')!.click();
    expect(store.get('websynth.ui.theme')).toBe('dark');
  });

  it('names what Auto picked, or would pick (REQ-auto-shows-what-it-would-pick)', async () => {
    await mount();
    expect(sel('theme-status')!.hidden).toBe(false);
    expect(sel('theme-status')!.textContent).toBe('Auto would pick Dark on this device.');
    sel('theme-auto')!.click();
    expect(sel('theme-status')!.textContent).toBe('Auto picked Dark on this device.');
  });

  it("shows the system's pick on the Auto tile, not the chosen theme, and follows the system live (regression)", async () => {
    // A system that prefers a light scheme, whose change listeners the test can fire.
    let light = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (q: string) => ({
      media: q,
      get matches() { return q.includes('light') && light; },
      addEventListener: (_t: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_t: string, fn: () => void) => { listeners.delete(fn); },
    }));
    const { tiles, THEMES, picker } = await mount();
    const chipsOf = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('[aria-hidden] > span')].map((c) => c.style.background);
    const swatchOf = (id: string) => THEMES.find((t) => t.id === id)!.swatch.map(norm);

    sel('theme-dark')!.click();
    expect(chipsOf(tiles[0]!)).toEqual(swatchOf('light'));
    expect(sel('theme-status')!.textContent).toBe('Auto would pick Light on this device.');
    // Picking another theme does not dress Auto in it.
    sel('theme-pastel')!.click();
    expect(chipsOf(tiles[0]!)).toEqual(swatchOf('light'));

    light = false;
    for (const fn of [...listeners]) fn();
    expect(chipsOf(tiles[0]!)).toEqual(swatchOf('dark'));
    expect(sel('theme-status')!.textContent).toBe('Auto would pick Dark on this device.');

    picker.destroy();
    expect(listeners.size).toBe(0);
  });

  it("paints each tile's chips with its theme's swatch", async () => {
    const { tiles, THEMES } = await mount();
    const chips = tiles[1]!.querySelectorAll<HTMLElement>('[aria-hidden] > span');
    expect(chips).toHaveLength(4);
    // jsdom normalises a hex to rgb(); compare through a probe so both read alike.
    expect([...chips].map((c) => c.style.background)).toEqual(THEMES[0]!.swatch.map(norm));
  });

  it('moves and selects with the arrows, Home and End, wrapping, and keeps the keys to itself', async () => {
    const { tiles } = await mount();
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    try {
      const n = tiles.length;
      const at = () => tiles.findIndex((t) => t.getAttribute('aria-checked') === 'true');
      const start = at();
      tiles[start]!.focus();

      expect(key(tiles[start]!, 'ArrowRight').defaultPrevented).toBe(true);
      expect(at()).toBe((start + 1) % n);
      expect(document.activeElement).toBe(tiles[at()]);
      expect(tiles[at()]!.tabIndex).toBe(0);

      key(tiles[at()]!, 'Home');
      expect(at()).toBe(0);
      key(tiles[0]!, 'ArrowLeft');
      expect(at()).toBe(n - 1); // wraps
      key(tiles[n - 1]!, 'End');
      expect(at()).toBe(n - 1);
      key(tiles[n - 1]!, 'ArrowDown');
      expect(at()).toBe(0); // wraps
      expect(store.get('websynth.ui.theme')).toBe('auto');
      expect(outside).not.toHaveBeenCalled();

      // Escape is not the picker's: it reaches the dialog.
      expect(key(tiles[0]!, 'Escape').defaultPrevented).toBe(false);
      expect(outside).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', outside);
    }
  });

  it('stops following theme changes once destroyed', async () => {
    const { picker } = await mount();
    const colors = await import('../../src/ui/theme-colors');
    sel('theme-auto')!.click();
    picker.destroy();
    sel('theme-status')!.textContent = 'stale';
    colors.invalidateScreenPalette();
    expect(sel('theme-status')!.textContent).toBe('stale');
  });
});

describe('the Settings dialog', () => {
  it('holds the theme picker above the performance tier', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { hardwareConcurrency: 12, deviceMemory: 16, userAgent: 'Windows' });
    const { createPerfSettingsButton } = await import('../../src/ui/components/perf-settings');
    const btn = createPerfSettingsButton();
    document.body.appendChild(btn);
    expect(btn.getAttribute('aria-label') ?? btn.title).toMatch(/^Settings/);
    btn.click();
    // A cold import after resetModules: give the lazy chunk room under a loaded full run.
    await vi.waitFor(() => { if (!sel('perf-mode')) throw new Error('modal not open yet'); }, { timeout: 5000 });
    const picker = sel('theme-picker')!;
    expect(picker).not.toBeNull();
    expect(picker.compareDocumentPosition(sel('perf-mode')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.textContent).toContain('Settings');
  });
});
