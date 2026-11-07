/**
 * MIDI clock-sync mode — a device-scoped transport-sync setting.
 *
 * Like performance mode (`perf-mode.ts`), this is deliberately **not** a
 * `ParamBus` param: whether *this* device leads or follows another instance is
 * setup state, not sound state, so it must never be captured into presets or
 * song files. Stored under the `websynth.*` convention with the same
 * `localStorage` try/catch pattern.
 */
import { readChoice, writePref } from './prefs';

const STORE_KEY = 'websynth.midisync';

export type SyncMode = 'off' | 'master' | 'slave';

const MODES: readonly SyncMode[] = ['off', 'master', 'slave'];

/** Stored mode, defaulting to 'off'. Bad/absent values read as 'off'. */
export function readSyncMode(): SyncMode {
  return readChoice(STORE_KEY, MODES, 'off');
}

export function writeSyncMode(mode: SyncMode): void {
  writePref(STORE_KEY, mode);
}
