/**
 * Performance mode — a device-scoped audio-quality preference.
 *
 * This is deliberately **not** a `ParamBus` param: it tunes the runtime for the
 * machine the app happens to be running on (audio buffer size, voice count,
 * scope cost), so it must NOT be captured into presets or song files. It is
 * stored on its own under the `websynth.*` convention, mirroring the
 * `localStorage` try/catch pattern in `ui/components/collapse-toggle.ts`.
 *
 * The buffer size (`latencyHint`) and voice count can only be chosen when the
 * `AudioContext`/voice pool are built, so they are read once at boot
 * (`main.ts`) — changing the preference takes full effect on the next reload.
 */

const STORE_KEY = 'websynth.perf';

export type PerfPref = 'auto' | 'on' | 'off';

/** Stored preference, defaulting to 'auto' (decide by device capability). */
export function readPerfPref(): PerfPref {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function writePerfPref(pref: PerfPref): void {
  try {
    localStorage.setItem(STORE_KEY, pref);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/**
 * Heuristic for a system likely to glitch at the smallest audio buffer: few
 * logical cores, little device memory, or a mobile user agent. Intentionally
 * conservative — a false positive only costs a little latency/polyphony, which
 * the user can override to 'off'.
 */
export function detectWeakDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const cores = navigator.hardwareConcurrency;
  if (typeof cores === 'number' && cores > 0 && cores <= 4) return true;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof mem === 'number' && mem <= 4) return true;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

/** Effective on/off — resolves 'auto' against {@link detectWeakDevice}. */
export function resolvePerfActive(pref: PerfPref = readPerfPref()): boolean {
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return detectWeakDevice();
}
