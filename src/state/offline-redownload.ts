/**
 * The one intent a factory reset writes back after wiping everything: "this
 * device had an offline copy — download it again" (specs/features/factory-reset.md
 * REQ-8, play-offline.md REQ-12).
 *
 * `sessionStorage`, not `localStorage`: the intent must survive exactly the
 * reload the reset triggers and die with the tab. A key this small is also what
 * lets `main.ts` check it at boot for the price of one read, without importing
 * the downloader.
 *
 * Every access is guarded: with storage blocked the reset simply does not
 * re-download, which is the degraded-not-broken posture the other `websynth.*`
 * keys take.
 */

export const OFFLINE_REDOWNLOAD_KEY = 'websynth.offline.redownload';

export function requestOfflineRedownload(): void {
  try {
    sessionStorage.setItem(OFFLINE_REDOWNLOAD_KEY, '1');
  } catch {
    /* storage unavailable — no re-download */
  }
}

/** Whether a reset asked for a re-download. Read-only: the boot check. */
export function offlineRedownloadPending(): boolean {
  try {
    return sessionStorage.getItem(OFFLINE_REDOWNLOAD_KEY) === '1';
  } catch {
    return false;
  }
}

/** Read and remove the intent, so a reload mid-download does not start it again. */
export function takeOfflineRedownload(): boolean {
  const pending = offlineRedownloadPending();
  try {
    sessionStorage.removeItem(OFFLINE_REDOWNLOAD_KEY);
  } catch {
    /* storage unavailable */
  }
  return pending;
}
