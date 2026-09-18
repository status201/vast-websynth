// Toasts for offline-copy runs (specs/features/play-offline.md REQ-offline-feedback-while-about-is-closed, REQ-the-copy-is-fetched-again-after-a-reset):
// the one module that raises `play-offline-toast`.
//
// Split from the About section because a run can start with no About card built
// at all — the re-download after a factory reset — and because two subscribers
// each raising their own toast would announce one run twice. So there is one
// watcher per `OfflineCopy`; the About section only tells it whether its inline
// view is showing, in which case the status line is the report and no toast is
// raised.
import { showToast } from './toast';
import { plural } from '../../utils/format';
import { takeOfflineRedownload } from '../../state/offline-redownload';
import {
  getOfflineCopy,
  type OfflineCopy,
  type OfflineErrorReason,
  type OfflineState,
} from '../../utils/offline-copy';

const TEST_ID = 'play-offline-toast';

/** Short enough to follow "Offline download stopped —". */
const STOPPED_BECAUSE: Record<OfflineErrorReason, (failed: number) => string> = {
  files: (n) => `${plural(n, 'file')} couldn't be downloaded`,
  offline: () => "couldn't reach the server",
  storage: () => 'not enough free storage',
  worker: () => "the offline helper didn't start",
};

export interface OfflineNotices {
  /** The inline view's "am I on screen?" test, or null when there is none. */
  setInlineView(showing: (() => boolean) | null): void;
}

const watchers = new WeakMap<OfflineCopy, OfflineNotices>();

/** The watcher for `copy`, created on first call. Idempotent (REQ-offline-feedback-while-about-is-closed). */
export function watchOfflineRuns(copy: OfflineCopy, reload: () => void): OfflineNotices {
  const existing = watchers.get(copy);
  if (existing) return existing;

  let inlineShowing: (() => boolean) | null = null;
  let previous = copy.state.kind;
  copy.subscribe((s) => {
    const ended = previous === 'downloading' && s.kind !== 'downloading';
    previous = s.kind;
    if (ended && !inlineShowing?.()) announce(s, copy, reload);
  });

  const notices: OfflineNotices = { setInlineView: (fn) => { inlineShowing = fn; } };
  watchers.set(copy, notices);
  return notices;
}

function announce(s: OfflineState, copy: OfflineCopy, reload: () => void): void {
  if (s.kind === 'complete') {
    showToast({ message: 'Ready to play offline.', testId: TEST_ID });
  } else if (s.kind === 'error') {
    showToast({
      message: `Offline download stopped — ${STOPPED_BECAUSE[s.reason](s.failed)}.`,
      actionLabel: 'Retry',
      onAction: () => void copy.start(),
      testId: TEST_ID,
    });
  } else if (s.kind === 'needs-reload') {
    showToast({
      message: 'A new version was installed — reload to save it offline.',
      actionLabel: 'Reload',
      onAction: reload,
      testId: TEST_ID,
    });
  }
  // `none` after a run is a user cancel, made where the status line already says so.
}

/**
 * After a factory reset deleted a complete offline copy, download it again
 * (REQ-the-copy-is-fetched-again-after-a-reset). Consumes the intent first, so a reload mid-download does not start
 * it over. Returns whether it started a run.
 */
export function resumeOfflineRedownload(
  copy: OfflineCopy = getOfflineCopy(),
  reload: () => void = () => location.reload(),
): boolean {
  if (!takeOfflineRedownload()) return false;
  watchOfflineRuns(copy, reload);
  showToast({ message: 'Downloading the offline copy again…', testId: TEST_ID });
  void copy.start();
  return true;
}
