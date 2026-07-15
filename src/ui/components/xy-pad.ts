import type { ParamBus } from '../../state/params';
import type { XyPadStore, XyAssign } from '../../state/xy-pad';
import type { EffectiveXy } from '../../state/xy-effective';
import { Dropdown } from './dropdown';
import { toNorm, fromNorm } from './taper';
import styles from '../styles/xy-pad.module.css';

/**
 * XY Pad surface — a Kaoss-pad-style square whose two axes each drive an
 * assignable `ParamBus` param. Dragging (or two-finger scroll) sweeps both
 * params through their tapers; on gesture end both **spring back** to their
 * pre-gesture values (momentary DJ-FX semantics). The axis assignment lives in
 * the pure `XyPadStore` (persisted via SongFile v3). No audio wiring here —
 * assignable params drive the live graph through the existing `bus.subscribe`.
 * See `specs/features/xy-pad.md`.
 *
 * When an `effective` source is passed (app.ts builds one from the motion
 * sequencer's play bank — xy-effective.ts), the pad's *axes* — labels, dot,
 * drag/wheel targets — follow the effective assignment so they stay truthful
 * while motion bank overrides play; the gear dropdowns still edit the base
 * `XyPadStore` assignment.
 */

/** Wheel sensitivity: normalized units per pixel of scroll. */
const WHEEL_K = 1 / 400;
/** Spring-back ramp duration (ms). */
const SPRING_MS = 180;

type GestureState = 'idle' | 'drag' | 'wheel';

export function createXyPad(
  bus: ParamBus,
  xy: XyPadStore,
  effective?: EffectiveXy,
): { el: HTMLElement; gear: HTMLElement; destroy(): void } {
  const ids = bus.ids().slice().sort();
  // The axes source: the effective assignment when provided, else the store.
  const axes: EffectiveXy = effective ?? {
    get: () => xy.get(),
    onChange: (cb) => xy.onChange(cb),
  };
  const initial = axes.get();
  let ax = initial.x;
  let ay = initial.y;

  const el = document.createElement('div');
  el.className = styles.root!;

  // --- Assign dropdowns (collapsed behind the title-bar gear to save space) ---
  const assignRow = document.createElement('div');
  assignRow.className = styles.assign!;

  const base = xy.get();
  const ddX = new Dropdown(ids, base.x);
  ddX.el.dataset.testid = 'xypad-assign-x';
  const ddY = new Dropdown(ids, base.y);
  ddY.el.dataset.testid = 'xypad-assign-y';

  assignRow.appendChild(labeled('X', ddX.el));
  assignRow.appendChild(labeled('Y', ddY.el));
  el.appendChild(assignRow);

  // --- Gear: toggles the assign row. Lives in the FloatingWindow title bar
  // (the caller places it via the window's `leading` slot). Starts collapsed so
  // the pad is compact; the on-surface axis labels keep the assignment visible.
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = styles.gearBtn!;
  gear.textContent = '⚙'; // ⚙
  gear.dataset.testid = 'xypad-gear';
  gear.setAttribute('aria-label', 'Axis assignment');
  // Stop the pointerdown so a click on the gear never starts a window drag.
  gear.addEventListener('pointerdown', (e) => e.stopPropagation());
  let assignOpen = false;
  function renderAssign(): void {
    assignRow.classList.toggle('collapsed', !assignOpen);
    gear.setAttribute('aria-expanded', String(assignOpen));
  }
  gear.addEventListener('click', () => {
    assignOpen = !assignOpen;
    renderAssign();
  });
  renderAssign();

  // --- Surface + dot ---
  const surface = document.createElement('div');
  surface.className = styles.surface!;
  surface.dataset.testid = 'xypad-surface';

  // --- Finer dotted grid: quarter-division lines at 25%/75% on both axes.
  // The 50% centre crosshair is drawn by the surface's ::before/::after; these
  // subdivide each existing quadrant into quarters (a 4x4 reference grid).
  const grid = document.createElement('div');
  grid.className = styles.grid!;
  for (const pct of [25, 75]) {
    const v = document.createElement('div');
    v.className = styles.gridV!;
    v.style.left = `${pct}%`;
    const h = document.createElement('div');
    h.className = styles.gridH!;
    h.style.top = `${pct}%`;
    grid.appendChild(v);
    grid.appendChild(h);
  }
  surface.appendChild(grid);

  // --- On-surface axis labels (short param name, kept in sync with ax/ay).
  const xLabel = document.createElement('span');
  xLabel.className = styles.axisLabelX!;
  xLabel.dataset.testid = 'xypad-axis-x';
  const yLabel = document.createElement('span');
  yLabel.className = styles.axisLabelY!;
  yLabel.dataset.testid = 'xypad-axis-y';
  surface.appendChild(xLabel);
  surface.appendChild(yLabel);
  function syncLabels(): void {
    xLabel.textContent = shortName(ax);
    yLabel.textContent = shortName(ay);
  }
  syncLabels();

  const dot = document.createElement('div');
  dot.className = styles.dot!;
  dot.dataset.testid = 'xypad-dot';
  surface.appendChild(dot);
  el.appendChild(surface);

  // --- Trackpad hint ---
  const hint = document.createElement('div');
  hint.className = styles.hint!;
  hint.dataset.testid = 'xypad-hint';
  hint.textContent = 'Two-finger scroll to nudge';
  el.appendChild(hint);

  // --- Gesture state ---
  let state: GestureState = 'idle';
  let pre: { x: number; y: number } | null = null;
  let rampRaf = 0;
  // Running normalized position for the (incremental) wheel gesture.
  let wheelNx = 0;
  let wheelNy = 0;

  // --- Dot rendering: subscribe to the two assigned params ---
  let unsubX = bus.subscribe(ax, setDotX);
  let unsubY = bus.subscribe(ay, setDotY);

  function setDotX(v: number): void {
    const def = bus.def(ax);
    if (!def) return;
    dot.style.left = `${clamp01(toNorm(def, v)) * 100}%`;
  }
  function setDotY(v: number): void {
    const def = bus.def(ay);
    if (!def) return;
    dot.style.top = `${(1 - clamp01(toNorm(def, v))) * 100}%`;
  }

  // --- Apply / gesture helpers ---
  function apply(nx: number, ny: number): void {
    const dx = bus.def(ax);
    const dy = bus.def(ay);
    if (dx) bus.set(ax, fromNorm(dx, clamp01(nx)));
    if (dy) bus.set(ay, fromNorm(dy, clamp01(ny)));
  }

  function applyFromEvent(e: PointerEvent): void {
    const rect = surface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = 1 - (e.clientY - rect.top) / rect.height;
    apply(nx, ny);
  }

  function cancelRamp(): void {
    if (rampRaf) {
      cancelAnimationFrame(rampRaf);
      rampRaf = 0;
    }
  }

  function startGesture(next: GestureState): void {
    // Mid-ramp restart keeps the ORIGINAL pre so a flurry of gestures still
    // returns to the true starting point, not a half-sprung one.
    if (rampRaf !== 0) cancelRamp();
    else pre = { x: bus.get(ax), y: bus.get(ay) };
    state = next;
  }

  function springBack(): void {
    state = 'idle';
    if (!pre) return;
    const axL = ax;
    const ayL = ay;
    const fromX = bus.get(axL);
    const fromY = bus.get(ayL);
    const toX = pre.x;
    const toY = pre.y;
    // `pre` stays set for the duration of the ramp: a gesture that restarts
    // mid-ramp (startGesture cancels the ramp but keeps `pre`) must spring back
    // to the ORIGINAL start, not the half-sprung value. It is cleared only when
    // the ramp actually completes (below) or a gesture aborts (abortGesture).
    const t0 = performance.now();
    const tick = (): void => {
      const k = Math.min(1, (performance.now() - t0) / SPRING_MS);
      const e = 1 - (1 - k) * (1 - k); // ease-out
      bus.set(axL, fromX + (toX - fromX) * e);
      bus.set(ayL, fromY + (toY - fromY) * e);
      if (k < 1) {
        rampRaf = requestAnimationFrame(tick);
      } else {
        bus.set(axL, toX); // exact snap
        bus.set(ayL, toY);
        rampRaf = 0;
        pre = null; // ramp finished cleanly -> next gesture recaptures fresh
      }
    };
    cancelRamp();
    rampRaf = requestAnimationFrame(tick);
  }

  /** Snap the current (old) axes back to `pre` and drop the gesture — used on
   *  axis reassignment and destroy. */
  function abortGesture(): void {
    cancelRamp();
    if (pre) {
      bus.set(ax, pre.x);
      bus.set(ay, pre.y);
    }
    pre = null;
    state = 'idle';
  }

  // --- Pointer / wheel handlers ---
  const onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    surface.setPointerCapture?.(e.pointerId);
    startGesture('drag');
    applyFromEvent(e);
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (state !== 'drag') return;
    applyFromEvent(e);
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (state !== 'drag') return;
    surface.releasePointerCapture?.(e.pointerId);
    springBack();
  };
  const onPointerLeave = (): void => {
    // A captured drag also fires leave, but a drag ends on pointerup — only a
    // wheel gesture ends on leaving the surface.
    if (state === 'wheel') springBack();
  };
  const onWheel = (e: WheelEvent): void => {
    if (state === 'drag') return;
    e.preventDefault(); // stop the page scrolling under the pad
    if (state !== 'wheel') {
      startGesture('wheel');
      const dx = bus.def(ax);
      const dy = bus.def(ay);
      wheelNx = dx ? clamp01(toNorm(dx, bus.get(ax))) : 0;
      wheelNy = dy ? clamp01(toNorm(dy, bus.get(ay))) : 0;
    }
    wheelNx = clamp01(wheelNx + e.deltaX * WHEEL_K);
    wheelNy = clamp01(wheelNy - e.deltaY * WHEEL_K);
    apply(wheelNx, wheelNy);
  };

  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerUp);
  surface.addEventListener('pointerleave', onPointerLeave);
  surface.addEventListener('wheel', onWheel, { passive: false });

  // --- Axis reassignment ---
  // The gear dropdowns show/edit the BASE assignment (the store is its single
  // writer); the pad's live axes follow the `axes` source, which may differ
  // while a motion bank override plays.
  ddX.onChange((v) => xy.set({ x: v }));
  ddY.onChange((v) => xy.set({ y: v }));

  const unsubStore = xy.onChange((a: XyAssign) => {
    ddX.setValue(a.x);
    ddY.setValue(a.y);
  });

  const unsubAxes = axes.onChange((a: XyAssign) => {
    if (a.x === ax && a.y === ay) return;
    abortGesture(); // snap the OLD axes home before switching
    ax = a.x;
    ay = a.y;
    syncLabels();
    unsubX();
    unsubY();
    unsubX = bus.subscribe(ax, setDotX); // fires immediately -> repaint
    unsubY = bus.subscribe(ay, setDotY);
  });

  function destroy(): void {
    abortGesture();
    unsubX();
    unsubY();
    unsubStore();
    unsubAxes();
    ddX.destroy();
    ddY.destroy();
  }

  return { el, gear, destroy };
}

function labeled(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = styles.field!;
  const span = document.createElement('span');
  span.className = styles.fieldLabel!;
  span.textContent = text;
  wrap.appendChild(span);
  wrap.appendChild(control);
  return wrap;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Short display name for a param id: its last dotted segment, lowercased
 *  (`filter.cutoff` -> `cutoff`). Used for the on-surface axis labels. */
function shortName(id: string): string {
  return (id.split('.').pop() ?? id).toLowerCase();
}
