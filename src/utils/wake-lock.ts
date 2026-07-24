/**
 * Screen Wake Lock manager — keeps the display awake while the synth is
 * audibly running (specs/features/pwa-install.md REQ-1).
 *
 * Policy is intent-based: `enable()` records that the lock is *wanted* and
 * requests it; the OS silently releases the lock whenever the tab is hidden,
 * so a `visibilitychange` listener re-requests it on return while still
 * wanted. Unsupported browsers (no `navigator.wakeLock`) and rejected
 * requests (battery saver, permissions policy) are silent no-ops — this
 * feature must never surface an error or block audio.
 *
 * Dependencies are injectable so the manager is unit-testable under jsdom
 * (which has neither a real `wakeLock` nor OS visibility behaviour).
 */
export class WakeLockManager {
  readonly supported: boolean;

  private readonly wakeLock: WakeLock | undefined;
  private readonly doc: Document;
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  /** Guards against overlapping request() calls racing each other. */
  private requesting = false;

  constructor(opts: { wakeLock?: WakeLock; doc?: Document } = {}) {
    this.wakeLock = opts.wakeLock ?? (typeof navigator !== 'undefined' ? navigator.wakeLock : undefined);
    this.doc = opts.doc ?? document;
    this.supported = this.wakeLock !== undefined;
    if (this.supported) {
      this.doc.addEventListener('visibilitychange', () => {
        if (this.wanted && !this.sentinel && !this.doc.hidden) void this.request();
      });
    }
  }

  /** Whether the lock is held right now (the OS drops it on tab hide). */
  get held(): boolean {
    return this.sentinel !== null;
  }

  /** Want the screen awake from now on; acquires the lock when possible. */
  enable(): void {
    this.wanted = true;
    if (this.supported && !this.sentinel) void this.request();
  }

  /** Stop wanting the lock and release it if held. */
  disable(): void {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s) void s.release().catch(() => {});
  }

  private async request(): Promise<void> {
    if (this.requesting || !this.wakeLock) return;
    this.requesting = true;
    try {
      const s = await this.wakeLock.request('screen');
      // The OS auto-releases on tab hide; drop our reference so the
      // visibilitychange path knows to re-request.
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
      });
      if (this.wanted) {
        this.sentinel = s;
      } else {
        // disable() ran while the request was in flight.
        void s.release().catch(() => {});
      }
    } catch {
      // Denied (battery saver, policy) — stay silent; a later
      // visibilitychange or enable() may try again.
    } finally {
      this.requesting = false;
    }
  }
}
