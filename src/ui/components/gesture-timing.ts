/**
 * The hand-rolled double-tap windows, in one place.
 *
 * `dblclick` is unreliable on touch, so five controls detect a double-tap off
 * timestamps themselves — the knob, the EQ graph, the scratch graph, the resize
 * handle and the motion pad. Each carried its own number, and one of them
 * carried a comment claiming it matched another when it did not.
 *
 * **Prefer `performance.now()` over `Date.now()`.** Wall time is not monotonic:
 * an NTP correction or a manual clock change lands as a jump, and a jump either
 * fabricates a double-tap or swallows one. Three of the five used it; the EQ
 * graph and the scratch graph now use `performance.now()` like the knob and the
 * resize handle.
 *
 * The **motion pad still reads `Date.now()`**, deliberately and for now: its
 * suite drives the gesture with fake timers, which move wall time but not
 * `performance.now()`, so every simulated press would land inside the window
 * and read as a double-tap. Changing the clock there means reshaping how that
 * suite fakes time — worth doing, but as its own change rather than smuggled
 * into a de-duplication.
 *
 * The *extra* conditions stay with their controls, because they genuinely
 * differ: the EQ graph also requires the second tap to be near the same band's
 * centre, the scratch graph requires the same breakpoint, and the others only
 * require the window. Only the numbers and the clock rule are shared.
 */

/** The common window: knob, EQ graph, scratch graph. */
export const DOUBLE_TAP_MS = 300;

/**
 * The longer window used by the resize handle and the motion pad.
 *
 * This is a **divergence, not a design**: the same gesture (double-tap to
 * reset/clear) has two tolerances depending on which control receives it, which
 * is the kind of hidden state [ADR-014](../../../specs/decisions/adr-014-dont-make-me-think.md)
 * rules against. Collapsing the two is a change to how the app *feels*, so it
 * wants a human at the controls rather than a quiet edit — until then the two
 * numbers at least sit side by side, where the difference is visible.
 */
export const LONG_DOUBLE_TAP_MS = 350;
