/*
 * Puts the stored UI theme on <html data-theme> before the first frame, so a
 * reload never flashes Dark first (specs/features/ui-themes.md
 * REQ-the-theme-applies-before-first-paint). A classic script, external because
 * the shipped CSP allows no inline script, loaded ahead of the stylesheets.
 *
 * It cannot import src/state/theme.ts, so it repeats the shipped ids, their meta
 * values and Auto's rule. tests/ui/theme.test.ts runs this file against
 * resolveTheme() and THEMES and fails if they disagree
 * (REQ-the-boot-script-agrees-with-the-registry) — add a theme in both.
 */
(function () {
  // id → [<meta name="theme-color">, <meta name="color-scheme">]
  var THEMES = {
    dark: ['#1a1a1a', 'dark'],
    light: ['#ece6da', 'light'],
    contrast: ['#000000', 'dark'],
  };
  var has = function (id) { return Object.prototype.hasOwnProperty.call(THEMES, id); };
  var matches = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };

  var id = null;
  try { id = localStorage.getItem('websynth.ui.theme'); } catch (e) { /* storage blocked */ }
  if (id === 'auto') {
    id = has('contrast') && matches('(prefers-contrast: more)') ? 'contrast'
      : has('light') && matches('(prefers-color-scheme: light)') ? 'light'
      : 'dark';
  }
  if (!has(id)) id = 'dark';

  document.documentElement.setAttribute('data-theme', id);
  var color = document.querySelector('meta[name="theme-color"]');
  if (color) color.setAttribute('content', THEMES[id][0]);
  var scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute('content', THEMES[id][1]);
})();
