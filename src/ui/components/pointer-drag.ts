/**
 * Whether the drag `pointerId` started on `el` is still live: it still holds
 * pointer capture there (runtime-performance.md REQ-a-drag-follows-only-its-own-pointer).
 *
 * A control ignores a second pointer while its drag is live, so a `pointerup`
 * that never arrives (an OS gesture, an app switch with no `pointercancel`)
 * would otherwise leave it deaf to every later touch. The capture goes with the
 * pointer, so its absence says the old drag is dead and the new touch may take
 * over. Without the capture API (jsdom) a drag is assumed live.
 */
export function dragStillHeld(el: Element | null, pointerId: number): boolean {
  if (!el || typeof el.hasPointerCapture !== 'function') return true;
  return el.hasPointerCapture(pointerId);
}
