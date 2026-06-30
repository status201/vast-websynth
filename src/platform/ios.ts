/**
 * iOS OS detection.
 *
 * Deliberately separate from `detectWeakDevice()` (`state/perf-mode.ts`): that
 * asks "is this hardware weak?", this asks "is this iOS?". They share neither a
 * heuristic nor a consequence — iOS needs the audio-session workarounds
 * (`audio/ios-audio-session.ts`) regardless of how capable the device is.
 */

/**
 * True on iPhone/iPad/iPod. Also catches iPadOS 13+ in its default desktop mode,
 * which reports a Mac user-agent but exposes multi-touch (`MacIntel` +
 * `maxTouchPoints > 1`). Safe when `navigator` is absent (SSR/tests) — returns
 * `false`.
 */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}
