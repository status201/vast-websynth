/**
 * A remembered on-screen size in px — a device-scoped *workspace* preference.
 *
 * Deliberately **not** a `ParamBus` param: it describes how the instrument is
 * arranged on *this* screen, not how it sounds, so it is never captured into a
 * preset or a song, and loading someone else's song never moves your panels or
 * resizes your windows. `null` means "nothing stored": the consumer's default,
 * often an automatic size its CSS already expresses.
 *
 * Shared by every resizable surface: the scope row (`scope-height.ts`), the
 * TRANSPORT window (transport-window.md REQ-the-window-width-is-resizable) and
 * the XY Pad (xy-pad.md REQ-the-pad-is-resizable). The keys are listed in
 * architecture.md's persistence keys.
 */

export const TRANSPORT_WIDTH_KEY = 'websynth.ui.window.transport.width';
export const XY_PAD_SIZE_KEY = 'websynth.ui.window.xypad.size';

/** The stored size, clamped to `[min, max]`; any miss, garbage or storage
 *  failure is `null`. */
export function readSizePref(key: string, min: number, max: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const px = Number.parseInt(raw, 10);
    if (!Number.isFinite(px)) return null;
    return Math.min(max, Math.max(min, px));
  } catch {
    return null; // private mode / disabled storage — non-fatal
  }
}

/** Persist a size (whole px). A full quota costs the preference, not the app. */
export function writeSizePref(key: string, px: number): void {
  if (!Number.isFinite(px)) return;
  try {
    localStorage.setItem(key, String(Math.round(px)));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/** Forget a size: the consumer's default again. */
export function clearSizePref(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
}
