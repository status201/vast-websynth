import { showToast } from './toast';
import { NOT_DOWNLOADED_YET, PLAY_OFFLINE_HINT } from '../offline-wording';
import { reportIfNewerVersion } from './version-skew-toast';

/**
 * The report a deferred surface owes the user when its `import()` rejects
 * (onboarding.md REQ-the-help-door-never-fails-silently, runtime-performance.md REQ-boot-cost-matches-the-request).
 *
 * Splitting a surface out of the entry chunk buys boot time and costs
 * reliability: a static import cannot fail once the app is running, an
 * `import()` can — the honest case being an offline revisit whose chunk was
 * never fetched while online, because the service worker caches only what the
 * page actually requested (pwa-install.md REQ-service-worker-is-registered). Left unhandled, the click
 * handler's `void open()` swallows the rejection and the control simply does
 * nothing, which reads as a broken app rather than a missing download.
 *
 * One place for the wording, because the distinction it draws is the useful
 * part: offline says *why* and what fixes it, online says the fetch failed.
 * Retry is offered either way — by the time the toast is read the connection
 * may well be back. The one exception: online, when a newer release is live,
 * the chunk is gone for good, so that report offers Reload (version-skew.md).
 */
export function showLazyLoadFailure(surface: string, retry: () => void): void {
  const failed = (cause: string): void => {
    showToast({
      message: `Couldn't open ${surface} — ${cause}`,
      actionLabel: 'Retry',
      onAction: retry,
      testId: 'lazy-load-failed-toast',
    });
  };
  // `navigator.onLine === false` is trustworthy (a false only ever means no
  // link); `true` merely means an interface is up, which is why the online
  // branch stays vague about the cause rather than blaming the network.
  if (navigator.onLine === false) {
    failed(`${NOT_DOWNLOADED_YET}. ${PLAY_OFFLINE_HINT}`);
    return;
  }
  // Online, a deploy may have replaced the chunk: then Retry can never work and
  // the report says Reload instead (version-skew.md REQ-a-stale-failure-offers-reload).
  void reportIfNewerVersion(`Couldn't open ${surface}`).then((skew) => {
    if (!skew) failed('the download failed.');
  });
}

/**
 * Import a deferred surface's module at its trigger, or report the failure and
 * resolve `null` (lazy-load-failure.md REQ-every-lazy-trigger-reports). `retry`
 * must re-run the whole gesture, not just the import
 * (REQ-retry-reruns-the-whole-gesture).
 */
export async function loadSurface<T>(surface: string, load: () => Promise<T>, retry: () => void): Promise<T | null> {
  try {
    return await load();
  } catch {
    showLazyLoadFailure(surface, retry);
    return null;
  }
}
