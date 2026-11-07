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
import { readPref, writePref } from './prefs';

export type ThemeId = 'dark' | 'light' | 'contrast' | 'pastel' | 'vibrant' | 'classic' | 'jungle' | 'race';
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
   * The picker tile's four chips — the colours that say which theme it is (Dark's
   * page, type and accents; Pastel's section faces). Each must be a colour the
   * theme declares, pinned by tests/ui/theme.test.ts.
   */
  swatch: readonly [string, string, string, string];
}

/** The shipped themes, in picker order. A theme not listed here cannot be chosen or stored. */
export const THEMES: readonly ThemeInfo[] = [
  { id: 'dark', name: 'Dark', metaColor: '#1a1a1a', colorScheme: 'dark', swatch: ['#0e0a06', '#e8d8b6', '#e8742e', '#f4cd5e'] },
  { id: 'light', name: 'Light', metaColor: '#ece6da', colorScheme: 'light', swatch: ['#cfc7b8', '#2a2118', '#a8440f', '#8f5c00'] },
  { id: 'pastel', name: 'Pastel', metaColor: '#141210', colorScheme: 'dark', swatch: ['#f0dc94', '#b7d3e9', '#f1b5a0', '#bcdcb4'] },
  { id: 'vibrant', name: 'Vibrant', metaColor: '#00363c', colorScheme: 'dark', swatch: ['#fb2c36', '#00afbd', '#ffbfa8', '#64beda'] },
  { id: 'classic', name: 'Classic', metaColor: '#03120e', colorScheme: 'dark', swatch: ['#03120e', '#26413c', '#8ab0ab', '#a9c2d0'] },
  { id: 'jungle', name: 'Jungle', metaColor: '#263a41', colorScheme: 'dark', swatch: ['#c3b59f', '#668f80', '#d6a2ad', '#a0af84'] },
  { id: 'race', name: 'Race', metaColor: '#011627', colorScheme: 'dark', swatch: ['#011627', '#f3a738', '#f71735', '#1c7293'] },
  { id: 'contrast', name: 'High contrast', metaColor: '#000000', colorScheme: 'dark', swatch: ['#000000', '#ffffff', '#ffb000', '#ffe600'] },
];

export const THEME_KEY = 'websynth.ui.theme';
/**
 * Auto's last resort, and so the look of a device that never chose
 * (REQ-auto-is-the-default). Where it does not ship, Dark: the tokens' own values.
 */
const DEFAULT_THEME: ThemeId = 'classic';

/** Auto's two system questions (REQ-auto-follows-the-system). */
export const CONTRAST_QUERY = '(prefers-contrast: more)';
export const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** True when `v` names a theme that ships. */
function isShipped(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v);
}

/** A shipped theme's entry; Dark (the first) for anything else. */
export function themeInfo(id: string): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/**
 * The stored choice, or `auto` for none — missing, unknown or not shipped
 * (REQ-auto-is-the-default; a stored value is untrusted, untrusted-input.md).
 */
export function readThemePref(): ThemePref {
  const v = readPref(THEME_KEY);
  return isShipped(v) ? v : 'auto';
}

export function writeThemePref(pref: ThemePref): void {
  writePref(THEME_KEY, pref);
}

/** Whether a media query matches on this device. Injected so the rule is testable. */
export type MediaMatch = (query: string) => boolean;

const systemMatch: MediaMatch = (q) =>
  typeof matchMedia === 'function' && matchMedia(q).matches;

/**
 * The theme a choice puts on the page. A shipped id is itself; `auto` (and
 * anything not shipped) asks the system: more contrast, then a light scheme,
 * then Classic (REQ-auto-follows-the-system). Each step only if that theme ships.
 */
export function resolveTheme(pref: ThemePref, matches: MediaMatch = systemMatch): ThemeId {
  if (isShipped(pref)) return pref;
  if (isShipped('contrast') && matches(CONTRAST_QUERY)) return 'contrast';
  if (isShipped('light') && matches(LIGHT_QUERY)) return 'light';
  return isShipped(DEFAULT_THEME) ? DEFAULT_THEME : 'dark';
}
