/**
 * Puts a theme on the document and keeps it there (specs/features/ui-themes.md).
 *
 * `public/theme-boot.js` has already applied the stored choice before first
 * paint; `startTheme()` takes over from it at boot, and follows the system while
 * the choice is Auto (REQ-auto-follows-the-system). The registry and the stored
 * choice are `state/theme.ts`; this is the DOM half.
 */
import {
  CONTRAST_QUERY,
  LIGHT_QUERY,
  readThemePref,
  resolveTheme,
  themeInfo,
  writeThemePref,
  type ThemeId,
  type ThemePref,
} from '../state/theme';
import { invalidateScreenPalette } from './theme-colors';

/** The choice in force — kept here so Auto still follows when storage is blocked. */
let pref: ThemePref | null = null;
let started = false;

/** `data-theme` and both metas; on an actual change, the canvases repaint (REQ-a-theme-change-repaints-the-canvases). */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  const changed = root.dataset.theme !== id;
  root.dataset.theme = id;
  const info = themeInfo(id);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', info.metaColor);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', info.colorScheme);
  if (changed) invalidateScreenPalette();
}

/** The choice in force: the stored one until `setThemePref` changes it. */
export function currentThemePref(): ThemePref {
  return (pref ??= readThemePref());
}

/** Boot: apply the choice (a no-op after theme-boot.js), then follow the system under Auto. Idempotent. */
export function startTheme(): void {
  if (started) return;
  started = true;
  applyTheme(resolveTheme(currentThemePref()));
  if (typeof matchMedia !== 'function') return;
  const follow = (): void => {
    if (currentThemePref() === 'auto') applyTheme(resolveTheme('auto'));
  };
  for (const q of [CONTRAST_QUERY, LIGHT_QUERY]) matchMedia(q).addEventListener('change', follow);
}

/** Store a choice and apply it at once (REQ-choosing-a-theme-previews-it). Returns the theme it resolved to. */
export function setThemePref(next: ThemePref): ThemeId {
  pref = next;
  writeThemePref(next);
  const id = resolveTheme(next);
  applyTheme(id);
  return id;
}
