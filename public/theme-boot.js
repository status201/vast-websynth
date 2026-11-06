/*
 * The two pre-paint jobs, so a reload never shows a wrong first frame: the
 * stored UI theme, then the stored UI scale. One file, because each extra
 * classic script here is another request that blocks the first paint.
 *
 * 1. The theme. Puts it on <html data-theme> before the first frame, so a
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
    pastel: ['#141210', 'dark'],
    vibrant: ['#00363c', 'dark'],
    classic: ['#03120e', 'dark'],
    jungle: ['#263a41', 'dark'],
    race: ['#011627', 'dark'],
    contrast: ['#000000', 'dark'],
  };
  var has = function (id) { return Object.prototype.hasOwnProperty.call(THEMES, id); };
  var matches = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };

  var id = null;
  try { id = localStorage.getItem('websynth.ui.theme'); } catch (e) { /* storage blocked */ }
  // Auto — and no choice (missing, unknown, not shipped), which is Auto
  // (REQ-auto-is-the-default): more contrast, then a light scheme, then Classic.
  if (!has(id)) {
    id = has('contrast') && matches('(prefers-contrast: more)') ? 'contrast'
      : has('light') && matches('(prefers-color-scheme: light)') ? 'light'
      : has('classic') ? 'classic'
      : 'dark';
  }

  document.documentElement.setAttribute('data-theme', id);
  var color = document.querySelector('meta[name="theme-color"]');
  if (color) color.setAttribute('content', THEMES[id][0]);
  var scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute('content', THEMES[id][1]);
})();

/*
 * 2. The UI scale (specs/features/ui-scale.md REQ-the-scale-applies-before-first-paint).
 * At 100% — nothing stored, or anything that is not exactly a stop — it touches
 * nothing (REQ-a-hundred-percent-is-a-no-op). A touch-first device rewrites the
 * viewport tag; everything else zooms <html> through CSSOM, which the CSP allows.
 *
 * It cannot import src/state/ui-scale.ts, so it repeats the stops, the key, the
 * engine query and the viewport string; tests/ui/ui-scale-boot.test.ts runs this
 * file against that module (REQ-the-boot-script-agrees-with-the-state).
 */
(function () {
  var STOPS = [50, 67, 75, 80, 90, 100, 110, 125, 150];
  var raw = null;
  try { raw = localStorage.getItem('websynth.ui.scale'); } catch (e) { /* storage blocked */ }
  if (raw === null) return;
  var pct = Number(raw);
  if (String(pct) !== raw || STOPS.indexOf(pct) < 0 || pct === 100) return;

  var s = pct / 100;
  var root = document.documentElement;
  var touch = !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  if (touch) {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    // Before the rewrite: WebKit folds the page scale into devicePixelRatio.
    root.setAttribute('data-ui-base-dpr', String(window.devicePixelRatio || 1));
    meta.setAttribute('content',
      'initial-scale=' + s + ', minimum-scale=' + s + ', maximum-scale=' + s + ', viewport-fit=cover, user-scalable=no');
  } else {
    root.style.setProperty('zoom', String(s));
    root.style.setProperty('--ui-zoom', String(s));
  }
})();
