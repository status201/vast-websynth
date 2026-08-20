import { showToast } from './toast';

/**
 * The report a deferred surface owes the user when its `import()` rejects
 * (onboarding.md REQ-24, runtime-performance.md REQ-1).
 *
 * Splitting a surface out of the entry chunk buys boot time and costs
 * reliability: a static import cannot fail once the app is running, an
 * `import()` can — the honest case being an offline revisit whose chunk was
 * never fetched while online, because the service worker caches only what the
 * page actually requested (pwa-install.md REQ-6). Left unhandled, the click
 * handler's `void open()` swallows the rejection and the control simply does
 * nothing, which reads as a broken app rather than a missing download.
 *
 * One place for the wording, because the distinction it draws is the useful
 * part: offline says *why* and what fixes it, online says the fetch failed.
 * Retry is offered either way — by the time the toast is read the connection
 * may well be back.
 */
export function showLazyLoadFailure(surface: string, retry: () => void): void {
  // `navigator.onLine === false` is trustworthy (a false only ever means no
  // link); `true` merely means an interface is up, which is why the online
  // branch stays vague about the cause rather than blaming the network.
  const offline = navigator.onLine === false;
  showToast({
    message: offline
      ? `Couldn't open ${surface} — you're offline and this part of the app isn't downloaded yet.`
      : `Couldn't open ${surface} — the download failed.`,
    actionLabel: 'Retry',
    onAction: retry,
    testId: 'lazy-load-failed-toast',
  });
}
