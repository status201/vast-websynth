/**
 * MIDI clock-sync mode — a device-scoped transport-sync setting.
 *
 * Like performance mode (`perf-mode.ts`), this is deliberately **not** a
 * `ParamBus` param: whether *this* device leads or follows another instance is
 * setup state, not sound state, so it must never be captured into presets or
 * song files. Stored under the `websynth.*` convention with the same
 * `localStorage` try/catch pattern.
 */

const STORE_KEY = 'websynth.midisync';

export type SyncMode = 'off' | 'master' | 'slave';

const MODES: readonly SyncMode[] = ['off', 'master', 'slave'];

/** Stored mode, defaulting to 'off'. Bad/absent values read as 'off'. */
export function readSyncMode(): SyncMode {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v && (MODES as readonly string[]).includes(v)) return v as SyncMode;
    return 'off';
  } catch {
    return 'off';
  }
}

export function writeSyncMode(mode: SyncMode): void {
  try {
    localStorage.setItem(STORE_KEY, mode);
  } catch {
    /* private mode / quota — non-fatal */
  }
}
