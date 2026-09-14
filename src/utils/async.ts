/**
 * Waiting, bounded. Three callers had each open-coded one of these: the
 * Engine's resume verify (audio-lifecycle.md), the factory reset's capped
 * wipes (factory-reset.md REQ-7/REQ-9) and the offline copy's worker poll
 * (play-offline.md REQ-5).
 */

/** Resolve after `ms`. An abort signal cuts the wait short — it resolves, never rejects. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Settle with `p`'s value, or with `fallback` if `p` rejects or `ms` elapses
 * first. Never rejects, and the timer is cleared either way, so a fast `p`
 * leaves nothing pending. A hang and a failure are the same answer here: the
 * caller has somewhere to be.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([p.then((v) => v, () => fallback), cap]).finally(() => clearTimeout(timer));
}
