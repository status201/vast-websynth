/**
 * Turn `wheel` events into whole steps of a stepped value (wheel-steps.md
 * REQ-a-wheel-gesture-steps-by-distance) — one rule for every control that moves
 * a semitone on scroll, so a mouse and a touchpad move it by the same amount for
 * the same intent.
 *
 * A mouse sends one event per notch; a touchpad sends dozens of small ones per
 * swipe. Counting events therefore sent a touchpad straight to the clamp. Instead:
 * the first event of a gesture steps at once (so one notch is always one step,
 * however few pixels the platform reports for it), and after that the distance
 * accumulates and steps every `WHEEL_NOTCH_PX` — never more than once per event,
 * so a fast mouse spin still moves one step per notch.
 */

/** Scroll distance that makes one further step within a gesture. */
export const WHEEL_NOTCH_PX = 40;

/** Quiet this long and the next event starts a new gesture. */
export const WHEEL_IDLE_MS = 200;

/** `deltaMode` 1 (lines) and 2 (pages), in pixels. */
const LINE_PX = 16;
const PAGE_PX = 400;

export type WheelStep = -1 | 0 | 1;

/**
 * One stepper per control — its accumulator is that control's alone. Scrolling
 * up (negative `deltaY`) is `+1`. `now` is injectable for tests.
 */
export function createWheelStepper(now: () => number = () => performance.now()): (e: WheelEvent) => WheelStep {
  let acc = 0;
  let dir = 0;
  let lastAt = -Infinity;
  return (e: WheelEvent): WheelStep => {
    const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
    const dy = e.deltaY * scale;
    if (dy === 0) return 0;
    const d = dy < 0 ? 1 : -1;
    const t = now();
    const fresh = t - lastAt > WHEEL_IDLE_MS || d !== dir;
    lastAt = t;
    if (fresh) {
      // A new gesture steps at once and starts counting distance from here.
      dir = d;
      acc = 0;
      return d;
    }
    acc += Math.abs(dy);
    if (acc < WHEEL_NOTCH_PX) return 0;
    // One step per event at most; keep only the remainder of this notch, so a
    // burst of large deltas cannot bank steps for later.
    acc = Math.min(acc - WHEEL_NOTCH_PX, WHEEL_NOTCH_PX - 1);
    return d;
  };
}
