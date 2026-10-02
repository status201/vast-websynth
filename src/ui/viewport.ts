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
