import styles from '../styles/value-bubble.module.css';

/**
 * A transient value readout pinned above the control under the pointer, for
 * gestures whose target is too small to carry its own label — the motion
 * sequencer's 16-per-lane pads (motion-sequencer.md REQ-22).
 *
 * Deliberately **not** a hover tooltip: it exists only while a gesture is
 * running, and disappears on release. The always-visible half of that
 * requirement is the per-lane header readout, which is what
 * [ADR-014](../../../specs/decisions/adr-014-dont-make-me-think.md) law 6 asks
 * for; this is the part that puts the number where the finger already is.
 *
 * One element, reused: `show` runs per `pointermove`, so it re-appends and
 * repositions rather than rebuilding, and only writes `textContent` when the
 * string actually changed (`specs/features/runtime-performance.md` REQ-6).
 */

/** Gap between the anchor and the bubble, and the viewport edge keep-out. */
const GAP_PX = 6;
const MARGIN_PX = 4;

export interface ValueBubbleOptions {
  /** A read-only gesture: styled as quiet chrome rather than an active write. */
  peek?: boolean;
  /** `data-testid` for the bubble. Default 'value-bubble'. */
  testId?: string;
}

let el: HTMLElement | null = null;
let lastText = '';

function ensureEl(testId: string): HTMLElement {
  if (!el) {
    el = document.createElement('div');
    el.className = styles.bubble!;
    el.setAttribute('aria-hidden', 'true'); // decorative: the value is in the lane readout
  }
  el.dataset.testid = testId;
  if (!el.isConnected) document.body.appendChild(el);
  return el;
}

export function showValueBubble(
  anchor: HTMLElement,
  text: string,
  opts: ValueBubbleOptions = {},
): void {
  const bubble = ensureEl(opts.testId ?? 'value-bubble');
  if (text !== lastText) {
    lastText = text;
    bubble.textContent = text;
  }
  bubble.classList.toggle(styles.peek!, !!opts.peek);

  const a = anchor.getBoundingClientRect();
  // offsetWidth/Height are 0 under jsdom (no layout); the clamps below then
  // simply resolve to the anchor's own edges, which is harmless.
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;

  let left = a.left + a.width / 2 - w / 2;
  const maxLeft = window.innerWidth - w - MARGIN_PX;
  if (left > maxLeft) left = maxLeft;
  if (left < MARGIN_PX) left = MARGIN_PX;

  // Above the anchor, flipping below when there is no room — a pad in the top
  // row would otherwise push the bubble off screen.
  let top = a.top - h - GAP_PX;
  if (top < MARGIN_PX) top = a.bottom + GAP_PX;

  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

/** Remove the bubble. It is detached rather than hidden, so "no bubble" is
 *  observable as an absent element. */
export function hideValueBubble(): void {
  el?.remove();
  lastText = '';
}
