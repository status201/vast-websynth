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
 * Ship extra themes for one test. Auto's rule names themes that land in later
 * stages; this checks the order it asks in, and the skip, before they exist.
 */
function withShipped(ids: ThemeInfo['id'][], fn: () => void): void {
  const list = THEMES as ThemeInfo[];
  const added = ids.map((id) => ({ ...THEMES[0]!, id, name: id }));
  list.push(...added);
  try { fn(); } finally { list.splice(list.length - added.length, added.length); }
}

describe('the stored theme (REQ-the-theme-is-a-device-preference)', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = installLocalStorageMock(); });
  afterEach(() => vi.unstubAllGlobals());

  it('is Dark when nothing is stored', () => {
    expect(readThemePref()).toBe('dark');
  });

  it('round-trips every shipped id and auto under websynth.ui.theme', () => {
    for (const v of [...THEMES.map((t) => t.id), 'auto' as const]) {
      writeThemePref(v);
      expect(store.get(THEME_KEY)).toBe(v);
      expect(readThemePref()).toBe(v);
    }
    expect(THEME_KEY).toBe('websynth.ui.theme');
  });

  it('reads an unknown or unshipped value as Dark (edge)', () => {
    const shipped = new Set<string>(THEMES.map((t) => t.id));
    const unshipped = (['light', 'contrast', 'pastel'] as const).filter((id) => !shipped.has(id));
    for (const v of ['neon', '__proto__', 'constructor', '', 'DARK', ...unshipped]) {
      store.set(THEME_KEY, v);
      expect(readThemePref(), v).toBe('dark');
    }
  });

  it('reads Dark when storage throws (edge)', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(readThemePref()).toBe('dark');
    expect(() => writeThemePref('auto')).not.toThrow();
  });
});

describe('resolving a choice (REQ-auto-follows-the-system)', () => {
  it('passes a shipped theme through, and turns anything else into Dark', () => {
    for (const t of THEMES) expect(resolveTheme(t.id, system())).toBe(t.id);
    expect(resolveTheme('neon' as never, system())).toBe('dark');
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
    // With Dark alone, Auto has nowhere else to go.
    if (THEMES.length === 1) expect(resolveTheme('auto', system(CONTRAST_QUERY, LIGHT_QUERY))).toBe('dark');
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
