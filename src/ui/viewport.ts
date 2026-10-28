/**
 * The two viewport breakpoints the shell decides layout by at mount. Both are
 * evaluated once, when a builder runs — there is no re-mount on resize in this
 * app — so they choose a *starting* state, never a live one.
 */

/**
 * True on viewports where the faceplate no longer fits one screen (≤1280px).
 * FX + pattern tabs auto-collapse here so the keyboard is reachable without
 * scrolling; an explicit user toggle is remembered and overrides this.
 */
export const isCompact = (): boolean => window.matchMedia('(max-width: 1280px)').matches;

/** True on phone-sized viewports — the keyboard's base range drops to 2 octaves
 *  so the keys stay large enough to play (keyboard-range.md REQ-the-range-follows-the-width). */
export const isPhone = (): boolean => window.matchMedia('(max-width: 767px)').matches;

/**
 * The classic vertical page scrollbar's width, or 0 with none (or an overlay
 * one). Unlike the two above it is read live: it is for a layout that must not
 * feed back through the scrollbar (keyboard-range.md
 * REQ-the-key-size-ignores-the-page-scrollbar). It is usually `<body>`'s, not the
 * viewport's: base.css makes both `height: 100%; overflow-y: auto`, so the body
 * is the scroller and `documentElement.clientWidth` never sees it, so both are
 * read. Clamped: a pinch-zoomed phone can report a negative difference, and
 * nothing real is wider than 40px.
 */
export function pageScrollbarWidth(): number {
  const body = document.body;
  const w = Math.max(
    body.offsetWidth - body.clientWidth,
    window.innerWidth - document.documentElement.clientWidth,
  );
  return Math.min(40, Math.max(0, w));
}
