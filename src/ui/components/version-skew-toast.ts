import { showToast } from './toast';
import { NEWER_VERSION_LIVE, RELOAD_LABEL, RELOAD_TO_GET_IT, TAKEOVER_NOTICE } from '../offline-wording';
import { isNewerVersion, newerVersionLive } from '../../utils/live-version';

/**
 * The reports a tab owes its user once a deploy has outrun it
 * (specs/features/version-skew.md). Imports only the toast, the wording leaf and
 * the probe leaf, so the eager lazy-load toast can depend on it for free.
 */

const reload = (): void => location.reload();

/**
 * A newer release, once seen, stays live for the rest of this page: no reload
 * happens behind the user's back. So the first confirmation — a probe or a
 * takeover — answers every later failure without asking the server again
 * (version-skew.md REQ-a-confirmed-skew-is-remembered).
 */
let skewConfirmed = false;

/** `lead` reads before the dash: "Couldn't open the demo library" (version-skew.md REQ-a-stale-failure-offers-reload). */
export function showNewerVersionToast(lead: string): void {
  showToast({
    message: `${lead} — ${NEWER_VERSION_LIVE}. ${RELOAD_TO_GET_IT}`,
    actionLabel: RELOAD_LABEL,
    onAction: reload,
    testId: 'version-skew-toast',
  });
}

/**
 * Ask whether a newer release is live and, if so, report the failure as that
 * (version-skew.md REQ-a-failure-asks-whether-a-newer-version-is-live). Resolves `true` when the
 * toast is up — the caller then skips its own report — and `false` otherwise.
 * Offline it asks nothing: the answer could only be "unknown".
 */
export async function reportIfNewerVersion(lead: string): Promise<boolean> {
  if (!skewConfirmed) {
    if (navigator.onLine === false || !(await newerVersionLive())) return false;
    skewConfirmed = true;
  }
  showNewerVersionToast(lead);
  return true;
}

/**
 * A worker for `version` has claimed this tab. Announced only when it is a
 * later release — the sentence says "newer" — and then sticky: the user may be
 * mid-performance and must choose the moment
 * (version-skew.md REQ-a-takeover-by-a-newer-worker-is-announced).
 */
export function onTakeover(version: string, ours: string = __APP_VERSION__): void {
  if (!isNewerVersion(version, ours)) return;
  skewConfirmed = true;
  showToast({
    message: TAKEOVER_NOTICE,
    actionLabel: RELOAD_LABEL,
    onAction: reload,
    durationMs: 0,
    testId: 'version-skew-takeover-toast',
  });
}
