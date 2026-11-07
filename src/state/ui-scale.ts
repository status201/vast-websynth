/**
 * UI scale — the stops, the stored value and the engine choice
 * (specs/features/ui-scale.md).
 *
 * Like the theme (`theme.ts`), the scale is how this device shows the app, not
 * part of the music: never a `ParamBus` param, never in a song, a preset or a
 * share link (REQ-the-scale-is-a-device-preference).
 *
 * `public/theme-boot.js` applies the stored scale before first paint and cannot
 * import this file, so it repeats the stops, the key, the engine query and the
 * viewport string; tests/ui/ui-scale-boot.test.ts runs it against this module
 * (REQ-the-boot-script-agrees-with-the-state). Change one, change both.
 */
import { readPref, writePref, removePref } from './prefs';

/** The browser's zoom steps from 50 to 150 (REQ-the-scale-snaps-to-browser-steps). */
export const UI_SCALE_STOPS: readonly number[] = [50, 67, 75, 80, 90, 100, 110, 125, 150];
export const UI_SCALE_DEFAULT = 100;
export const UI_SCALE_KEY = 'websynth.ui.scale';

/** A touch-first device scales through the viewport tag; everything else through CSS zoom (REQ-one-value-two-engines). */
export const ENGINE_QUERY = '(hover: none) and (pointer: coarse)';
export type UiScaleEngine = 'viewport' | 'zoom';

/** index.html's viewport content — what 100% restores (REQ-a-hundred-percent-is-a-no-op). Pinned to the file by a test. */
export const SHIPPED_VIEWPORT = 'width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no';

export function isScaleStop(v: unknown): v is number {
  return typeof v === 'number' && UI_SCALE_STOPS.includes(v);
}

/**
 * The stored scale; 100 for nothing stored, blocked storage, or anything that is
 * not exactly a stop's decimal string (untrusted-input.md).
 */
export function readUiScale(): number {
  const raw = readPref(UI_SCALE_KEY);
  if (raw === null) return UI_SCALE_DEFAULT;
  const n = Number(raw);
  return isScaleStop(n) && String(n) === raw ? n : UI_SCALE_DEFAULT;
}

/** Store a stop; 100 is stored as the key's absence. Anything else is ignored. */
export function writeUiScale(pct: number): void {
  if (!isScaleStop(pct)) return;
  if (pct === UI_SCALE_DEFAULT) removePref(UI_SCALE_KEY);
  else writePref(UI_SCALE_KEY, String(pct));
}

/** Whether a media query matches here. Injected so the choice is testable. */
export type MediaMatch = (query: string) => boolean;

const systemMatch: MediaMatch = (q) =>
  typeof matchMedia === 'function' && matchMedia(q).matches;

export function pickEngine(matches: MediaMatch = systemMatch): UiScaleEngine {
  return matches(ENGINE_QUERY) ? 'viewport' : 'zoom';
}

/**
 * The viewport content for a scale other than 100: the scale pinned, and no
 * `width`, so the browser sizes the layout viewport to device width ÷ scale in
 * either orientation.
 */
export function scaledViewport(pct: number): string {
  const s = pct / 100;
  return `initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, viewport-fit=cover, user-scalable=no`;
}
