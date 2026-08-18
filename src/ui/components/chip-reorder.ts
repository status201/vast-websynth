/**
 * Drag-to-reorder for a row of chips — `specs/features/arrangement.md` REQ-11.
 *
 * Wired once here rather than per lane (`recipes/design-an-interaction.md`
 * step 3): all four chain lanes come out of the same `buildChainLane`, and a
 * gesture copy-pasted four times is four places for it to drift.
 *
 * Like `grid-gestures.ts`, this controller reports **intent and nothing else**.
 * It never moves a chip in the DOM: the owner writes the new order to state and
 * the existing re-render draws it, so a drop can never leave the row showing an
 * order the arrangement does not hold. All it paints is the drag affordance.
 *
 * The row of the inventory it implements, and the one it must not steal:
 *   drag past the slop    reorder: remove at `from`, insert at `to`
 *   press under the slop  no-op here — the chip's own click listener still
 *                         selects, which is what lets the two share one target
 *
 * A press is ambiguous until it travels, so nothing is decided on `pointerdown`.
 * That is the same latch `grid-gestures.ts` uses to tell a tap from a paint
 * stroke, and it is why the "a drag would fight selection" objection in the
 * spec's v5 inventory no longer holds.
 */

/** Marks a chip for the drag's hit-testing; owned by this module. */
const CHIP_ATTR = 'data-chip-reorder';
/** The same 6 px `grid-gestures.ts` uses — one slop for the whole app. */
const DEFAULT_SLOP_PX = 6;

export interface ChipReorderOptions {
  /**
   * The chips' shared parent. Needed for one thing only, but a load-bearing
   * one: it is where the post-drop click is swallowed. See `onUp`.
   */
  container: HTMLElement;
  /** The chips, in chain order. Re-supplied on every structural rebuild. */
  chips: readonly HTMLElement[];
  /**
   * Commit a move: the slot at `from` lands at `to`, both indices into the
   * ORIGINAL array. Called once per drag, on drop — never during it.
   */
  onReorder(from: number, to: number): void;
  slopPx?: number;
}

/**
 * Turn a gap index (0..length, "which slot would I sit in front of") into the
 * insert index the caller's splice needs. Removing `from` first shifts every
 * later gap down by one, which is the off-by-one every reorder gets wrong once.
 */
function landingIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

export function attachChipReorder(opts: ChipReorderOptions): () => void {
  const slopPx = opts.slopPx ?? DEFAULT_SLOP_PX;

  // Reverse lookup: a drag resolves the chip under the pointer by hit-testing,
  // not from the closure of the listener that started it. It doubles as the
  // lane guard — another lane's chips carry the same attribute but are absent
  // from this map, so a drag can never cross from one machine to another.
  const index = new Map<Element, number>();
  opts.chips.forEach((chip, i) => {
    index.set(chip, i);
    chip.setAttribute(CHIP_ATTR, '');
    // preventDefault() alone does not stop touch panning — the browser has to
    // be told up front that this element handles its own gestures.
    chip.style.touchAction = 'none';
  });

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let from = -1;
  /** A press that has not yet travelled far enough to be a drag. */
  let pending = false;
  let dragging = false;
  /** Gap the drop would use, in ORIGINAL-array coordinates; -1 = nowhere. */
  let gap = -1;

  // jsdom dispatches plain MouseEvents for pointer types, so `pointerId` can be
  // absent; normalise rather than compare against undefined.
  const idOf = (e: PointerEvent): number => (typeof e.pointerId === 'number' ? e.pointerId : -1);

  const clearMarks = (): void => {
    for (const chip of opts.chips) delete chip.dataset.dragOver;
  };

  const reset = (): void => {
    const src = from >= 0 ? opts.chips[from] : undefined;
    if (src) delete src.dataset.dragging;
    clearMarks();
    pointerId = null;
    from = -1;
    gap = -1;
    pending = false;
    dragging = false;
  };

  /**
   * Show the gap the drop would use. The row is a wrapping flex, so the marker
   * is an attribute on the neighbouring chip (drawn as an edge bar in CSS)
   * rather than a real inserted element — nothing reflows, and a chip that has
   * wrapped to the next line still marks the correct side of itself.
   */
  const markGap = (): void => {
    clearMarks();
    if (gap < 0) return;
    const after = gap >= opts.chips.length;
    const chip = after ? opts.chips[opts.chips.length - 1] : opts.chips[gap];
    if (chip) chip.dataset.dragOver = after ? 'after' : 'before';
  };

  const onMove = (e: PointerEvent): void => {
    if (pointerId === null || idOf(e) !== pointerId) return;
    if (pending) {
      if (Math.abs(e.clientX - startX) < slopPx && Math.abs(e.clientY - startY) < slopPx) return;
      pending = false;
      dragging = true;
      const src = opts.chips[from];
      if (src) src.dataset.dragging = 'true';
    }
    if (!dragging) return;
    // Touch implicitly captures the pointer to the origin element, so the chip
    // under the finger has to be hit-tested. `e.target` is the jsdom fallback.
    const hit = document.elementFromPoint?.(e.clientX, e.clientY) ?? (e.target as Element | null);
    const over = hit?.closest?.(`[${CHIP_ATTR}]`) ?? null;
    const at = over ? index.get(over) : undefined;
    if (at === undefined) {
      // Off this lane's row — withdraw the marker, so the drop reads as the
      // cancel it is about to be rather than keeping a stale target lit.
      gap = -1;
      markGap();
      return;
    }
    // Before or after, decided against the chip's own midpoint — the idiom
    // every list reorder uses, and the only way a drop can land past the last
    // chip and append rather than swapping with it.
    const box = (over as HTMLElement).getBoundingClientRect();
    gap = e.clientX < box.left + box.width / 2 ? at : at + 1;
    markGap();
  };

  const onUp = (e: PointerEvent): void => {
    if (pointerId === null || idOf(e) !== pointerId) return;
    detachDrag();
    const committed = dragging && gap >= 0;
    const to = committed ? landingIndex(from, gap) : -1;
    if (dragging) {
      // The drop must not ALSO read as a click, or it would toggle the very
      // selection the reorder just moved.
      //
      // This has to sit on the container, not on the chip, for two separate
      // reasons. A drag that ends over a different chip fires its click on the
      // nearest common ancestor — the container — so a chip-mounted listener
      // would never see it. And even for a drag that ends where it began, a
      // capture listener on the TARGET fires in registration order alongside
      // the target's own bubble listeners, which the chip registered first: at
      // the target there is no capture phase left to win. An ancestor's capture
      // listener genuinely runs before both.
      //
      // `once` so a real click consumes it, plus a macrotask sweep so a drag
      // with no click behind it (touch, a stray release) cannot leave the
      // swallower armed for the user's next genuine tap. The click follows
      // pointerup in the same task, so it always beats that timer.
      const swallow = (ev: Event): void => { ev.stopPropagation(); ev.preventDefault(); };
      opts.container.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => opts.container.removeEventListener('click', swallow, { capture: true }), 0);
    }
    const fromIdx = from;
    reset();
    // A drop onto its own gap resolves to `from` and writes nothing — picking a
    // chip up and putting it back is not an edit.
    if (committed && to >= 0 && to !== fromIdx) opts.onReorder(fromIdx, to);
  };

  const onCancel = (e: PointerEvent): void => {
    if (pointerId === null || idOf(e) !== pointerId) return;
    detachDrag();
    reset(); // a cancelled pointer writes nothing (REQ-11)
  };

  function detachDrag(): void {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
  }

  const disposers: (() => void)[] = [];

  opts.chips.forEach((chip, i) => {
    const onDown = (e: PointerEvent): void => {
      if (pointerId !== null) return; // one drag at a time
      if (e.button > 0) return;       // secondary button -> contextmenu
      pointerId = idOf(e);
      startX = e.clientX;
      startY = e.clientY;
      from = i;
      gap = -1;
      pending = true;
      dragging = false;
      // Stops the press becoming a text selection or a scroll before the slop
      // check has decided what the gesture is (design-an-interaction.md step 5).
      e.preventDefault();
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
    };
    chip.addEventListener('pointerdown', onDown);
    disposers.push(() => {
      chip.removeEventListener('pointerdown', onDown);
      chip.removeAttribute(CHIP_ATTR);
      chip.style.touchAction = '';
    });
  });

  return () => {
    detachDrag();
    reset();
    for (const d of disposers) d();
  };
}
