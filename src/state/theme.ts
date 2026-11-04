/**
 * UI themes — the registry and the device preference (specs/features/ui-themes.md).
 *
 * Like the perf tier (`perf-mode.ts`), a theme is how this device shows the app,
 * not part of the music: it is never a `ParamBus` param and never travels in a
 * song, a preset or a share link (REQ-the-theme-is-a-device-preference).
 *
 * `public/theme-boot.js` applies the stored choice before first paint and cannot
 * import this file, so it keeps its own copy of the ids, the meta values and
 * Auto's rule; tests/ui/theme.test.ts runs it against `resolveTheme()` and
 * `THEMES` (REQ-the-boot-script-agrees-with-the-registry). Add a theme in both.
 */

export type ThemeId = 'dark' | 'light' | 'contrast' | 'pastel';
export type ThemePref = ThemeId | 'auto';

export interface ThemeInfo {
  id: ThemeId;
  /** The picker label. */
  name: string;
  /** `<meta name="theme-color">` — the browser's own chrome around the app. */
  metaColor: string;
  /** `<meta name="color-scheme">` — native scrollbars and form controls. */
  colorScheme: 'dark' | 'light';
  /**
   * The picker tile's chips: the theme's `--bg`, `--text`, `--accent` and
   * `--accent-secondary`. Pinned equal to its stylesheet by tests/ui/theme.test.ts.
   */
  swatch: readonly [string, string, string, string];
}

/** The shipped themes, in picker order. A theme not listed here cannot be chosen or stored. */
export const THEMES: readonly ThemeInfo[] = [
  { id: 'dark', name: 'Dark', metaColor: '#1a1a1a', colorScheme: 'dark', swatch: ['#0e0a06', '#e8d8b6', '#e8742e', '#f4cd5e'] },
];

export const THEME_KEY = 'websynth.ui.theme';
export const DEFAULT_THEME: ThemeId = 'dark';

/** Auto's two system questions (REQ-auto-follows-the-system). */
export const CONTRAST_QUERY = '(prefers-contrast: more)';
export const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** True when `v` names a theme that ships. */
export function isShipped(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v);
}

/** A shipped theme's entry; Dark for anything else. */
export function themeInfo(id: string): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** The stored choice; `dark` when missing, unknown or not shipped (untrusted-input.md). */
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'auto' || isShipped(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode / quota — the choice still applies for this visit */
  }
}

/** Whether a media query matches on this device. Injected so the rule is testable. */
export type MediaMatch = (query: string) => boolean;

const systemMatch: MediaMatch = (q) =>
  typeof matchMedia === 'function' && matchMedia(q).matches;

/**
 * The theme a choice puts on the page. `auto` asks the system: more contrast,
 * then a light scheme, then Dark — each step only if that theme ships.
 */
export function resolveTheme(pref: ThemePref = readThemePref(), matches: MediaMatch = systemMatch): ThemeId {
  if (pref !== 'auto') return isShipped(pref) ? pref : DEFAULT_THEME;
  if (isShipped('contrast') && matches(CONTRAST_QUERY)) return 'contrast';
  if (isShipped('light') && matches(LIGHT_QUERY)) return 'light';
  return DEFAULT_THEME;
}
