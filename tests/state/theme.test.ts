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

  it('is Auto when nothing is stored (REQ-auto-is-the-default)', () => {
    expect(readThemePref()).toBe('auto');
  });

  it('round-trips every shipped id and auto under websynth.ui.theme', () => {
    for (const v of [...THEMES.map((t) => t.id), 'auto' as const]) {
      writeThemePref(v);
      expect(store.get(THEME_KEY)).toBe(v);
      expect(readThemePref()).toBe(v);
    }
    expect(THEME_KEY).toBe('websynth.ui.theme');
  });

  it('reads an unknown or unshipped value as Auto (edge, REQ-auto-is-the-default)', () => {
    const shipped = new Set<string>(THEMES.map((t) => t.id));
    const unshipped = (['light', 'contrast', 'pastel'] as const).filter((id) => !shipped.has(id));
    for (const v of ['neon', '__proto__', 'constructor', '', 'DARK', ...unshipped]) {
      store.set(THEME_KEY, v);
      expect(readThemePref(), v).toBe('auto');
    }
  });

  it('reads Auto when storage throws (edge)', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(readThemePref()).toBe('auto');
    expect(() => writeThemePref('auto')).not.toThrow();
  });
});

describe('resolving a choice (REQ-auto-follows-the-system)', () => {
  it('passes a shipped theme through, and resolves anything else as Auto', () => {
    for (const t of THEMES) expect(resolveTheme(t.id, system())).toBe(t.id);
    expect(resolveTheme('neon' as never, system())).toBe('classic');
    expect(resolveTheme('neon' as never, system(LIGHT_QUERY))).toBe('light');
  });

  it('asks for more contrast first, then a light scheme, then lands on Classic', () => {
    expect(resolveTheme('auto', system(CONTRAST_QUERY, LIGHT_QUERY))).toBe('contrast');
    expect(resolveTheme('auto', system(CONTRAST_QUERY))).toBe('contrast');
    expect(resolveTheme('auto', system(LIGHT_QUERY))).toBe('light');
    expect(resolveTheme('auto', system())).toBe('classic');
  });

  it('skips a rule whose theme does not ship', () => {
    withShipped(['light', 'classic'], () => {
      expect(resolveTheme('auto', system(CONTRAST_QUERY, LIGHT_QUERY))).toBe('light');
    });
    withShipped(['contrast', 'classic'], () => {
      expect(resolveTheme('auto', system(LIGHT_QUERY))).toBe('classic');
    });
    // Where Classic does not ship, Dark — the tokens' own values.
    withShipped(['light', 'contrast'], () => {
      expect(resolveTheme('auto', system())).toBe('dark');
    });
    // With Dark alone, Auto has nowhere else to go.
    withShipped([], () => {
      expect(resolveTheme('auto', system(CONTRAST_QUERY, LIGHT_QUERY))).toBe('dark');
    });
  });

  it('lands on Classic where there is no matchMedia (edge)', () => {
    // The node environment has none: the default system answers no to everything.
    expect(typeof globalThis.matchMedia).toBe('undefined');
    expect(resolveTheme('auto')).toBe('classic');
  });

  it('gives Dark for an id the registry does not list', () => {
    expect(themeInfo('neon').id).toBe('dark');
    for (const t of THEMES) expect(themeInfo(t.id)).toBe(t);
  });
});
