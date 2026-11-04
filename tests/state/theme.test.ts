// The theme registry and the stored choice (specs/features/ui-themes.md).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import {
  THEMES,
  THEME_KEY,
  CONTRAST_QUERY,
  LIGHT_QUERY,
  readThemePref,
  writeThemePref,
  resolveTheme,
  themeInfo,
  type ThemeInfo,
} from '../../src/state/theme';

/** A system where exactly these queries match. */
const system = (...on: string[]) => (q: string) => on.includes(q);

/**
 * Run with exactly these themes shipped (Dark first), whatever the registry
 * lists today — so Auto's order and its skip are checked for every mix.
 */
function withShipped(ids: ThemeInfo['id'][], fn: () => void): void {
  const list = THEMES as ThemeInfo[];
  const saved = [...list];
  const entry = (id: ThemeInfo['id']) => saved.find((t) => t.id === id) ?? { ...saved[0]!, id, name: id };
  list.splice(0, list.length, ...(['dark', ...ids] as const).map(entry));
  try { fn(); } finally { list.splice(0, list.length, ...saved); }
}

describe('the stored theme (REQ-the-theme-is-a-device-preference)', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = installLocalStorageMock(); });
  afterEach(() => vi.unstubAllGlobals());

  it('is no choice when nothing is stored', () => {
    expect(readThemePref()).toBeNull();
  });

  it('round-trips every shipped id and auto under websynth.ui.theme', () => {
    for (const v of [...THEMES.map((t) => t.id), 'auto' as const]) {
      writeThemePref(v);
      expect(store.get(THEME_KEY)).toBe(v);
      expect(readThemePref()).toBe(v);
    }
    expect(THEME_KEY).toBe('websynth.ui.theme');
  });

  it('reads an unknown or unshipped value as no choice (edge)', () => {
    const shipped = new Set<string>(THEMES.map((t) => t.id));
    const unshipped = (['light', 'contrast', 'pastel'] as const).filter((id) => !shipped.has(id));
    for (const v of ['neon', '__proto__', 'constructor', '', 'DARK', ...unshipped]) {
      store.set(THEME_KEY, v);
      expect(readThemePref(), v).toBeNull();
    }
  });

  it('reads no choice when storage throws (edge)', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(readThemePref()).toBeNull();
    expect(() => writeThemePref('auto')).not.toThrow();
  });
});

describe('resolving a choice (REQ-auto-follows-the-system)', () => {
  it('passes a shipped theme through, and treats anything else as no choice', () => {
    for (const t of THEMES) expect(resolveTheme(t.id, system())).toBe(t.id);
    expect(resolveTheme('neon' as never, system())).toBe('vibrant');
  });
});

describe('no choice (REQ-vibrant-is-the-default)', () => {
  it('is Vibrant under a light or a dark system alike', () => {
    expect(resolveTheme(null, system())).toBe('vibrant');
    expect(resolveTheme(null, system(LIGHT_QUERY))).toBe('vibrant');
  });

  it('gives way to High contrast when the system asks for more contrast', () => {
    expect(resolveTheme(null, system(CONTRAST_QUERY))).toBe('contrast');
    expect(resolveTheme(null, system(CONTRAST_QUERY, LIGHT_QUERY))).toBe('contrast');
  });

  it('falls back to Dark where Vibrant does not ship, and keeps the contrast rule only if it does', () => {
    withShipped([], () => {
      expect(resolveTheme(null, system(CONTRAST_QUERY))).toBe('dark');
    });
    withShipped(['contrast'], () => {
      expect(resolveTheme(null, system(CONTRAST_QUERY))).toBe('contrast');
      expect(resolveTheme(null, system())).toBe('dark');
    });
  });

  it('asks for more contrast first, then a light scheme, then lands on Dark', () => {
    withShipped(['light', 'contrast'], () => {
      expect(resolveTheme('auto', system(CONTRAST_QUERY, LIGHT_QUERY))).toBe('contrast');
      expect(resolveTheme('auto', system(LIGHT_QUERY))).toBe('light');
      expect(resolveTheme('auto', system())).toBe('dark');
    });
  });

  it('skips a rule whose theme does not ship', () => {
    withShipped(['light'], () => {
      expect(resolveTheme('auto', system(CONTRAST_QUERY, LIGHT_QUERY))).toBe('light');
    });
    withShipped(['contrast'], () => {
      expect(resolveTheme('auto', system(LIGHT_QUERY))).toBe('dark');
    });
    // With Dark alone, Auto has nowhere else to go.
    withShipped([], () => {
      expect(resolveTheme('auto', system(CONTRAST_QUERY, LIGHT_QUERY))).toBe('dark');
    });
  });

  it('lands on Dark where there is no matchMedia (edge)', () => {
    // The node environment has none: the default system answers no to everything.
    expect(typeof globalThis.matchMedia).toBe('undefined');
    expect(resolveTheme('auto')).toBe('dark');
  });

  it('gives Dark for an id the registry does not list', () => {
    expect(themeInfo('neon').id).toBe('dark');
    for (const t of THEMES) expect(themeInfo(t.id)).toBe(t);
  });
});
