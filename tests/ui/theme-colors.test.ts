// @vitest-environment jsdom
//
// The canvases' colour source (specs/features/ui-themes.md REQ-canvas-reads-the-screen-tokens).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DARK_SCREEN, invalidateScreenPalette, onPaletteChange, paletteDerived, parseColor, rgba, screenPalette,
  type ScreenPalette,
} from '../../src/ui/theme-colors';

afterEach(() => {
  invalidateScreenPalette();
  vi.restoreAllMocks();
});

// process.cwd(), not import.meta.url: under jsdom the global URL is jsdom's, which fs rejects.
/** theme.css's `:root` tokens, with var() chains resolved — what the default theme computes. */
function darkTokens(): Map<string, string> {
  const css = readFileSync(path.join(process.cwd(), 'src/styles/theme.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{([^{}]*)\}/.exec(css)![1]!;
  const raw = new Map([...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  const resolve = (v: string): string => v.replace(/var\((--[\w-]+)\)/g, (_m, n: string) => resolve(raw.get(n)!));
  return new Map([...raw].map(([k, v]) => [k, resolve(v)]));
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe('screenPalette (REQ-canvas-reads-the-screen-tokens)', () => {
  it('falls back to Dark where a token does not resolve to a colour (edge)', () => {
    // jsdom has no cascade, so var(--screen-ink) resolves to nothing here.
    expect(screenPalette()).toEqual(DARK_SCREEN);
  });

  it('resolves once and serves the cache until invalidated', () => {
    const spy = vi.spyOn(window, 'getComputedStyle');
    const a = screenPalette();
    const calls = spy.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(screenPalette()).toBe(a);
    expect(spy.mock.calls.length).toBe(calls);
    invalidateScreenPalette();
    screenPalette();
    expect(spy.mock.calls.length).toBeGreaterThan(calls);
  });

  it('keeps its Dark fallback equal to theme.css (no drift)', () => {
    const tokens = darkTokens();
    const names: Record<keyof ScreenPalette, string> = {
      ink: '--screen-ink', trace: '--screen-trace', hot: '--screen-hot',
      highlight: '--screen-highlight', cue: '--screen-cue',
    };
    for (const [key, token] of Object.entries(names) as [keyof ScreenPalette, string][]) {
      const v = tokens.get(token);
      expect(v, token).toMatch(/^#[0-9a-f]{6}$/i);
      expect([...DARK_SCREEN[key]], token).toEqual(hex(v!));
    }
  });
});

describe('a theme change (REQ-a-theme-change-repaints-the-canvases)', () => {
  it('tells each subscriber once per change, and the next read resolves afresh', () => {
    const before = screenPalette();
    const fn = vi.fn(() => expect(screenPalette()).not.toBe(before));
    const off = onPaletteChange(fn);
    invalidateScreenPalette();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    invalidateScreenPalette();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('lets a subscriber unsubscribe while being told (a canvas destroyed by the repaint)', () => {
    const second = vi.fn();
    const offFirst: () => void = onPaletteChange(() => offFirst());
    const offSecond = onPaletteChange(second);
    invalidateScreenPalette();
    expect(second).toHaveBeenCalledTimes(1);
    offSecond();
  });
});

describe('colour helpers', () => {
  it('parses every form getComputedStyle hands back', () => {
    expect(parseColor('rgb(244, 205, 94)')).toEqual([244, 205, 94]);
    expect(parseColor('rgba(232, 116, 46, 0.5)')).toEqual([232, 116, 46]);
    expect(parseColor('rgb(255 58 32 / 0.5)')).toEqual([255, 58, 32]);
    expect(parseColor('color(srgb 1 0.5 0)')).toEqual([255, 128, 0]);
    expect(parseColor('var(--screen-ink)')).toBeNull();
    expect(parseColor('')).toBeNull();
  });

  it('writes a canvas colour from a base and an alpha (REQ-an-alpha-derives-from-its-base)', () => {
    expect(rgba([244, 205, 94], 0.07)).toBe('rgba(244, 205, 94, 0.07)');
    expect(rgba([232, 116, 46])).toBe('rgb(232, 116, 46)');
  });

  it('rebuilds a derived set only when the palette changes', () => {
    const build = vi.fn((p: ScreenPalette) => rgba(p.ink, 0.5));
    const get = paletteDerived(build);
    expect(get()).toBe('rgba(244, 205, 94, 0.5)');
    get();
    expect(build).toHaveBeenCalledTimes(1);
    invalidateScreenPalette();
    get();
    expect(build).toHaveBeenCalledTimes(2);
  });
});
