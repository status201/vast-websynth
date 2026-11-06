/**
 * Puts a UI scale on the page, and the helpers that let code which mixes
 * viewport coordinates with element sizes stay right under it
 * (specs/features/ui-scale.md).
 *
 * At 100% this module applies nothing and every helper returns its input
 * (REQ-a-hundred-percent-is-a-no-op): the state is a few numbers, read without
 * touching the DOM, so the helpers are safe on any path that already measures.
 */
import {
  UI_SCALE_DEFAULT,
  SHIPPED_VIEWPORT,
  isScaleStop,
  readUiScale,
  pickEngine,
  scaledViewport,
  type UiScaleEngine,
} from '../state/ui-scale';

let engine: UiScaleEngine | null = null;
/** The applied percentage. */
let pct = UI_SCALE_DEFAULT;
/** The CSS zoom on <html>: the scale on the zoom engine, else 1. */
let zoom = 1;
/** The viewport engine's pixel ratio from before the first rewrite; 0 = not captured. */
let baseDpr = 0;
const listeners = new Set<() => void>();

const engineNow = (): UiScaleEngine => (engine ??= pickEngine());

/**
 * Adopt what `public/theme-boot.js` applied before first paint. Applies the
 * stored scale itself when the boot script did not (an older cached copy), and
 * at 100% touches nothing.
 */
export function initUiScale(): void {
  engineNow();
  const base = Number(document.documentElement.dataset.uiBaseDpr);
  if (base > 0) baseDpr = base;
  const stored = readUiScale();
  if (stored !== UI_SCALE_DEFAULT) write(stored);
}

/**
 * Apply a stop live: write it to the page, tell the canvases, and dispatch one
 * `resize` so every existing re-layout runs (REQ-a-scale-change-is-a-resize).
 * A no-op for the scale already applied and for anything that is not a stop.
 */
export function applyUiScale(next: number): void {
  if (!isScaleStop(next) || next === pct) return;
  engineNow();
  write(next);
  if (engine === 'zoom') requery(document.documentElement);
  for (const fn of [...listeners]) {
    try { fn(); } catch (err) { console.error('[ui-scale] listener failed', err); }
  }
  window.dispatchEvent(new Event('resize'));
}

function write(next: number): void {
  pct = next;
  const root = document.documentElement;
  const s = next / 100;
  if (engine === 'zoom') {
    zoom = next === UI_SCALE_DEFAULT ? 1 : s;
    if (next === UI_SCALE_DEFAULT) {
      root.style.removeProperty('zoom');
      root.style.removeProperty('--ui-zoom');
      if (!root.style.cssText) root.removeAttribute('style');
    } else {
      root.style.setProperty('zoom', String(s));
      root.style.setProperty('--ui-zoom', String(s));
    }
    return;
  }
  zoom = 1;
  const meta = document.querySelector('meta[name="viewport"]');
  if (next === UI_SCALE_DEFAULT) {
    delete root.dataset.uiBaseDpr;
    meta?.setAttribute('content', SHIPPED_VIEWPORT);
    return;
  }
  // Before the rewrite: WebKit folds the page scale into devicePixelRatio, Chromium does not.
  if (!baseDpr) baseDpr = window.devicePixelRatio || 1;
  root.dataset.uiBaseDpr = String(baseDpr);
  meta?.setAttribute('content', scaledViewport(next));
}

/**
 * Make the browser re-evaluate the `viewport` container queries after a live
 * zoom change. Firefox answers them against the new zoom at load, but after a
 * live change it keeps the old answer, because the container's box in screen px
 * did not move. Dropping the containment for one forced layout and restoring
 * it makes it ask again. Runs once per committed live change only, never at
 * boot, where every engine already gets it right
 * (ui-scale.md REQ-breakpoints-follow-the-effective-width).
 *
 * The drop is a data attribute that `base.css` matches, not an inline style:
 * Chromium writes an inline-style change back to the `style` attribute lazily,
 * so setting and removing a property and then removing the attribute leaves
 * `style=""` behind once the late write-back lands.
 */
function requery(root: HTMLElement): void {
  root.dataset.uiRequery = '';
  void root.offsetWidth;
  delete root.dataset.uiRequery;
}

/** The applied scale, as a percentage. */
export function currentUiScale(): number {
  return pct;
}

/** The CSS zoom on <html>: the scale on the zoom engine, else 1. */
export function cssZoom(): number {
  return zoom;
}

/** A viewport-px length (clientX, a rect edge, innerWidth) in the page's own zoomed px. */
export function toLocal(px: number): number {
  return zoom === 1 ? px : px / zoom;
}

export interface LocalRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** A `getBoundingClientRect()` in local px; the same object at zoom 1 (REQ-coordinates-are-converted-at-the-read). */
export function localRect(r: DOMRectReadOnly): LocalRect {
  if (zoom === 1) return r;
  return {
    left: r.left / zoom,
    top: r.top / zoom,
    right: r.right / zoom,
    bottom: r.bottom / zoom,
    width: r.width / zoom,
    height: r.height / zoom,
  };
}

/** The window's width / height in local px. */
export function viewportWidth(): number {
  return toLocal(window.innerWidth);
}
export function viewportHeight(): number {
  return toLocal(window.innerHeight);
}

/** Bitmap px per CSS px for a canvas (REQ-canvases-stay-sharp-at-any-scale). */
export function backingScale(): number {
  const dpr = window.devicePixelRatio || 1;
  if (zoom !== 1) return dpr * zoom;
  if (engine === 'viewport' && pct !== UI_SCALE_DEFAULT) return (baseDpr || dpr) * (pct / 100);
  return dpr;
}

/** Run `fn` after each applied change; returns the unsubscribe. */
export function onUiScaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
