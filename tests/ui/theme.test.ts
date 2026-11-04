// Putting a theme on the page, before first paint and after (specs/features/ui-themes.md).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installLocalStorageMock } from '../storage-mock';
import type { ThemeInfo } from '../../src/state/theme';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const BOOT = read('public/theme-boot.js');

const CONTRAST = '(prefers-contrast: more)';
const LIGHT = '(prefers-color-scheme: light)';

/** A matchMedia whose answers the test sets, and whose change listeners it can fire. */
function stubSystem(...initially: string[]) {
  const on = new Set(initially);
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('matchMedia', (q: string) => ({
    media: q,
    get matches() { return on.has(q); },
    addEventListener: (_t: string, fn: () => void) => {
      if (!listeners.has(q)) listeners.set(q, new Set());
      listeners.get(q)!.add(fn);
    },
    removeEventListener: (_t: string, fn: () => void) => { listeners.get(q)?.delete(fn); },
  }));
  return {
    set(q: string, matches: boolean): void {
      if (matches) on.add(q); else on.delete(q);
      for (const fn of listeners.get(q) ?? []) fn();
    },
  };
}

/** The two metas index.html ships, at their Dark values. */
function resetHead(): void {
  document.head.innerHTML = '<meta name="theme-color" content="#1a1a1a"><meta name="color-scheme" content="dark">';
  delete document.documentElement.dataset.theme;
}
const meta = (name: string) => document.querySelector(`meta[name="${name}"]`)!.getAttribute('content');

/** Fresh copies of the theme modules — `ui/theme.ts` keeps the choice in force and a started flag. */
async function fresh() {
  vi.resetModules();
  const state = await import('../../src/state/theme');
  const ui = await import('../../src/ui/theme');
  const colors = await import('../../src/ui/theme-colors');
  return { state, ui, colors };
}

/** Ship extra themes (same entries as Dark, other ids) in a fresh registry, for Auto's live rule. */
function ship(themes: readonly ThemeInfo[], ids: ThemeInfo['id'][]): void {
  (themes as ThemeInfo[]).push(...ids.map((id) => ({ ...themes[0]!, id, name: id })));
}

let store: Map<string, string>;
beforeEach(() => {
  store = installLocalStorageMock();
  resetHead();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetHead();
});

describe('applying a theme (REQ-the-theme-applies-before-first-paint)', () => {
  it('sets data-theme and both metas from the registry', async () => {
    const { state, ui } = await fresh();
    for (const t of state.THEMES) {
      ui.applyTheme(t.id);
      expect(document.documentElement.dataset.theme).toBe(t.id);
      expect(meta('theme-color')).toBe(t.metaColor);
      expect(meta('color-scheme')).toBe(t.colorScheme);
    }
  });

  it('repaints the canvases once per change, and not for the theme already on (REQ-a-theme-change-repaints-the-canvases)', async () => {
    const { ui, colors } = await fresh();
    const fn = vi.fn();
    const off = colors.onPaletteChange(fn);
    ui.applyTheme('dark');
    expect(fn).toHaveBeenCalledTimes(1);
    ui.applyTheme('dark');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    delete document.documentElement.dataset.theme;
    ui.applyTheme('dark');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stores and applies a choice at once (REQ-choosing-a-theme-previews-it)', async () => {
    const { ui } = await fresh();
    expect(ui.setThemePref('auto')).toBe('dark');
    expect(store.get('websynth.ui.theme')).toBe('auto');
    expect(ui.currentThemePref()).toBe('auto');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('following the system (REQ-auto-follows-the-system)', () => {
  it('re-resolves under Auto when a system query changes', async () => {
    const sys = stubSystem();
    store.set('websynth.ui.theme', 'auto');
    const { state, ui } = await fresh();
    ship(state.THEMES, ['light', 'contrast']);
    ui.startTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    sys.set(LIGHT, true);
    expect(document.documentElement.dataset.theme).toBe('light');
    sys.set(CONTRAST, true);
    expect(document.documentElement.dataset.theme).toBe('contrast');
    sys.set(CONTRAST, false);
    sys.set(LIGHT, false);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('leaves a concrete choice alone when the system changes', async () => {
    const sys = stubSystem();
    store.set('websynth.ui.theme', 'auto');
    const { state, ui } = await fresh();
    ship(state.THEMES, ['light']);
    ui.startTheme();
    ui.setThemePref('dark');
    sys.set(LIGHT, true);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('starts once, however often it is called', async () => {
    stubSystem();
    const { ui } = await fresh();
    const add = vi.spyOn(globalThis, 'matchMedia');
    ui.startTheme();
    ui.startTheme();
    expect(add).toHaveBeenCalledTimes(2); // one per query, once
  });
});

describe('the boot script (REQ-the-boot-script-agrees-with-the-registry)', () => {
  /** Run public/theme-boot.js against the current storage and system. */
  const boot = () => new Function(BOOT)();

  it('puts the same theme and metas on the page as the registry would, for every stored value and system', async () => {
    const { state } = await fresh();
    const stored = [null, 'auto', 'dark', 'light', 'contrast', 'pastel', 'neon', '__proto__', 'constructor', 'toString', ''];
    const systems = [[], [LIGHT], [CONTRAST], [CONTRAST, LIGHT]];
    for (const v of stored) {
      for (const on of systems) {
        stubSystem(...on);
        store.clear();
        if (v !== null) store.set('websynth.ui.theme', v);
        resetHead();
        boot();
        const want = state.themeInfo(state.resolveTheme(state.readThemePref()));
        const at = `stored ${String(v)}, system [${on.join(' ')}]`;
        expect(document.documentElement.dataset.theme, at).toBe(want.id);
        expect(meta('theme-color'), at).toBe(want.metaColor);
        expect(meta('color-scheme'), at).toBe(want.colorScheme);
      }
    }
  });

  it('knows every shipped theme', async () => {
    const { state } = await fresh();
    stubSystem();
    for (const t of state.THEMES) {
      store.set('websynth.ui.theme', t.id);
      resetHead();
      boot();
      expect(document.documentElement.dataset.theme).toBe(t.id);
    }
  });

  it('survives blocked storage and a missing matchMedia (edge)', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    vi.stubGlobal('matchMedia', undefined);
    expect(boot).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('delivery (REQ-the-theme-applies-before-first-paint)', () => {
  it('loads theme-boot.js as a classic script ahead of the first stylesheet', () => {
    const html = read('index.html');
    const tag = /<script src="\/theme-boot\.js"><\/script>/.exec(html);
    expect(tag, 'index.html loads /theme-boot.js as a plain classic script').not.toBeNull();
    expect(tag!.index).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    // After the metas it sets, so they exist when it runs.
    expect(tag!.index).toBeGreaterThan(html.indexOf('<meta name="color-scheme"'));
    expect(tag!.index).toBeGreaterThan(html.indexOf('<meta name="theme-color"'));
  });

  it('precaches theme-boot.js, so an installed app applies the theme offline', () => {
    const assets = /var CORE_ASSETS = \[([\s\S]*?)\];/.exec(read('public/sw.js'));
    expect(assets).not.toBeNull();
    expect(assets![1]).toContain("'/theme-boot.js'");
  });
});

describe('the picker swatches (REQ-a-theme-is-a-palette-and-two-faces)', () => {
  /** `--name: value` in the theme's own block — theme.css's :root for Dark, its file for the rest. */
  function tokensOf(id: string): Map<string, string> {
    const css = (id === 'dark' ? read('src/styles/theme.css') : read(`src/styles/themes/${id}.css`))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const selector = id === 'dark' ? /^:root$/ : new RegExp(`^:root\\[data-theme=["']${id}["']\\]$`);
    const map = new Map<string, string>();
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selector.test(m[1]!.trim())) continue;
      for (const t of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(t[1]!, t[2]!.trim().toLowerCase());
    }
    return map;
  }

  it('shows only colours the theme itself declares', async () => {
    const { state } = await fresh();
    for (const t of state.THEMES) {
      const own = new Set(tokensOf(t.id).values());
      expect(t.swatch.filter((c) => !own.has(c.toLowerCase())), `${t.id}'s swatch`).toEqual([]);
    }
  });
});
