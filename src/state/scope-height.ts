/**
 * Scope panel height — a device-scoped *workspace* preference.
 *
 * Like `perf-mode.ts` and `keyboard-layout.ts` this is deliberately **not** a
 * `ParamBus` param: it describes how the instrument is arranged on *this* screen,
 * not how it sounds, so it must never be captured into presets or song files.
 * Loading someone else's song must not move your panels.
 *
 * The scope's other state (Wave/Spectrum, Mono/Stereo, the peak-hold) stays
 * transient by design — that is *view* state. Height is furniture.
 * See `specs/features/scope.md` REQ-19/REQ-20 → Persistence.
 *
 * The value is the height of `.bottom`'s first grid track in px, which the
 * scope and the PITCH/OCT/MOD wheel strips share.
 */

const STORE_KEY = 'websynth.ui.scope.height';

/** px — the pre-v11 fixed row height, and the floor. */
export const SCOPE_H_MIN = 130;
/** px — exactly twice the minimum, the ceiling. */
export const SCOPE_H_MAX = 260;
/** px — what a fresh boot, a double-tap and `Home` all give. */
export const SCOPE_H_DEFAULT = SCOPE_H_MIN;
/** px — arrow-key increment on the focused handle. */
export const SCOPE_H_STEP = 8;

/**
 * Clamp to the supported range, rounded to whole px. Non-finite input (`NaN`
 * from a `parseInt` of garbage, an `Infinity` from arithmetic) resolves to the
 * default rather than propagating — every entry point funnels through here, so
 * an unusable panel is unreachable.
 */
export function clampScopeHeight(px: number): number {
  if (!Number.isFinite(px)) return SCOPE_H_DEFAULT;
  return Math.min(SCOPE_H_MAX, Math.max(SCOPE_H_MIN, Math.round(px)));
}

/** The stored height, clamped. Any miss, garbage or storage failure → default. */
export function readScopeHeight(): number {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return SCOPE_H_DEFAULT;
    return clampScopeHeight(Number.parseInt(raw, 10));
  } catch {
    return SCOPE_H_DEFAULT; // private mode / disabled storage — non-fatal
  }
}

/** Persist the height, clamped. A full quota costs the preference, not the app. */
export function writeScopeHeight(px: number): void {
  try {
    localStorage.setItem(STORE_KEY, String(clampScopeHeight(px)));
  } catch {
    /* private mode / quota — non-fatal */
  }
}
