/**
 * Android OS detection.
 *
 * The sibling of `isIOS()` (`platform/ios.ts`) and, for the same reason, kept
 * apart from `detectTier()` (`state/perf-mode.ts`): that asks "how capable is
 * this hardware?", this asks "is this Android?". Android needs the Media Session
 * keep-alive (`audio/media-session.ts`) no matter how fast the device is.
 */

/**
 * True on Android (phones, tablets, and Chrome/Firefox/Samsung Internet alike —
 * they all carry `Android` in the UA). Safe when `navigator` is absent
 * (SSR/tests) — returns `false`.
 */
export function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}
