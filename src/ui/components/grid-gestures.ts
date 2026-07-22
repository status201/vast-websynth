/**
 * The one gesture controller every trigger grid (seq / drum / sampler) shares —
 * `specs/features/step-grid-editing.md`. It reports *intent* and never paints:
 * the panels' existing PatternStore subscriptions stay the only thing that
 * writes cell visuals, so a stroke cannot desynchronise from a repaint.
 *
 * The inventory (REQ-1/REQ-3/REQ-4), one outcome per gesture, no modes:
 *   tap                    toggle `on` + select      (TR-808 and every DAW)
 *   drag                   paint !first.on           (FL Studio, Ableton)
 *   long-press / right-click   select WITHOUT toggling   (Elektron, Push)
 *
 * The tap's toggle is deliberately deferred to `pointerup`: at press time a
 * gesture is still ambiguous (tap? drag? hold?), and hold-to-edit only works if
 * nothing has been written yet. For a real tap the delay is the press itself.
 */

/** Marks a cell for the stroke's hit-testing; owned by this module. */
const CELL_ATTR = 'data-grid-cell';
const DEFAULT_HOLD_MS = 350;
const DEFAULT_SLOP_PX = 6;

export interface GridGestureOptions {
  /** `[row][col]`; a single-row grid passes `[cells]`. */
  cells: readonly (readonly HTMLElement[])[];
  /** Read the live store — never cached DOM state (a bank switch may land mid-stroke). */
  isOn(row: number, col: number): boolean;
  /** Tap and paint both write through here. */
  onToggle(row: number, col: number, on: boolean): void;
  /** Runs first for every gesture, so the edit row already points at the cell. */
  onSelect(row: number, col: number): void;
  /** Class toggled on a cell while a long-press is registered (visual feedback). */
  heldClass?: string;
  holdMs?: number;
  slopPx?: number;
}

export function attachGridGestures(opts: GridGestureOptions): () => void {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;
  const slopPx = opts.slopPx ?? DEFAULT_SLOP_PX;

  // Reverse lookup: a paint stroke resolves cells by hit-testing the pointer,
  // not from the closure of the listener that started it.
  const coords = new Map<Element, readonly [number, number]>();
  for (let r = 0; r < opts.cells.length; r++) {
    const row = opts.cells[r]!;
    for (let c = 0; c < row.length; c++) {
      const el = row[c];
      if (!el) continue;
      coords.set(el, [r, c] as const);
      el.setAttribute(CELL_ATTR, '');
      // preventDefault() alone does not stop touch panning — the browser needs
      // to know up front that this element handles its own gestures.
      el.style.touchAction = 'none';
    }
  }

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let origin: readonly [number, number] | null = null;
  let paintValue = false;
  /** A press that is still ambiguous — tap vs drag vs hold. */
  let pending = false;
  let painting = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let heldCell: HTMLElement | null = null;
  const painted = new Set<Element>();

  // jsdom dispatches plain MouseEvents for pointer types, so `pointerId` can be
  // absent; normalise rather than compare against undefined.
  const idOf = (e: PointerEvent): number => (typeof e.pointerId === 'number' ? e.pointerId : -1);

  const clearHeld = (): void => {
    if (heldCell && opts.heldClass) heldCell.classList.remove(opts.heldClass);
    heldCell = null;
  };

  const reset = (): void => {
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
    clearHeld();
    pointerId = null;
    origin = null;
    pending = false;
    painting = false;
    painted.clear();
  };

  /** Apply the latched paint value once per cell — re-crossing must not flicker. */
  const paintAt = (el: Element | null): void => {
    if (!el || painted.has(el)) return;
    const rc = coords.get(el);
    if (!rc) return;
    painted.add(el);
    if (opts.isOn(rc[0], rc[1]) === paintValue) return;
    opts.onToggle(rc[0], rc[1], paintValue);
  };

  const onMove = (e: PointerEvent): void => {
    if (pointerId === null || idOf(e) !== pointerId) return;
    if (pending) {
      if (Math.abs(e.clientX - startX) < slopPx && Math.abs(e.clientY - startY) < slopPx) return;
      // Travelled: a paint stroke. Cancel the hold and apply the latch to the
      // cell the stroke began on, which no gesture has written yet.
      if (holdTimer !== undefined) {
        clearTimeout(holdTimer);
        holdTimer = undefined;
      }
      pending = false;
      painting = true;
      if (origin) paintAt(opts.cells[origin[0]]?.[origin[1]] ?? null);
    }
    if (!painting) return;
    // Touch implicitly captures the pointer to the origin element, so the cell
    // under the finger has to be hit-tested. `e.target` is the jsdom fallback.
    const hit = document.elementFromPoint?.(e.clientX, e.clientY) ?? (e.target as Element | null);
    paintAt(hit?.closest?.(`[${CELL_ATTR}]`) ?? null);
  };

  const onUp = (e: PointerEvent): void => {
    if (pointerId === null || idOf(e) !== pointerId) return;
    detachStroke();
    // Still pending on release ⇒ neither a drag nor a hold ⇒ a plain tap.
    if (pending && origin) opts.onToggle(origin[0], origin[1], paintValue);
    reset();
  };

  function detachStroke(): void {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
  }

  const disposers: (() => void)[] = [];

  for (const [el, [r, c]] of coords) {
    const cell = el as HTMLElement;

    const onDown = (e: PointerEvent): void => {
      if (pointerId !== null) return;           // one stroke at a time
      if (e.button > 0) return;                 // secondary button → contextmenu
      pointerId = idOf(e);
      startX = e.clientX;
      startY = e.clientY;
      origin = [r, c];
      paintValue = !opts.isOn(r, c);
      pending = true;
      painting = false;
      painted.clear();
      e.preventDefault();
      opts.onSelect(r, c);                      // selection follows every press
      holdTimer = setTimeout(() => {
        holdTimer = undefined;
        pending = false;                        // hold-to-edit: select only (REQ-3)
        if (opts.heldClass) {
          cell.classList.add(opts.heldClass);
          heldCell = cell;
        }
      }, holdMs);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    };

    // Desktop alias for hold-to-edit. Never the only route to it — a phone has
    // no right-click (step-grid-editing.md REQ-3).
    const onContext = (e: MouseEvent): void => {
      e.preventDefault();
      opts.onSelect(r, c);
    };

    cell.addEventListener('pointerdown', onDown);
    cell.addEventListener('contextmenu', onContext);
    disposers.push(() => {
      cell.removeEventListener('pointerdown', onDown);
      cell.removeEventListener('contextmenu', onContext);
      cell.removeAttribute(CELL_ATTR);
      cell.style.touchAction = '';
    });
  }

  return () => {
    detachStroke();
    reset();
    for (const d of disposers) d();
  };
}
