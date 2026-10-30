/**
 * Run `fn` once the browser is idle — the boot path's way of starting work
 * nobody is waiting for (runtime-performance.md REQ-boot-cost-matches-the-request):
 * `main.ts`'s warms, the Song panel's demo blurbs.
 *
 * `requestIdleCallback` only reached Safari in 17.4, and we target installed iOS
 * PWAs, so it falls back to a plain 2 s timeout. (A `'x' in window` guard would
 * narrow `window` itself to `never` in the else branch; probe the function.)
 */
export function whenIdle(fn: () => void): void {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn);
  else window.setTimeout(fn, 2000);
}
