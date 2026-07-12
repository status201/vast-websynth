import { describe, it, expect, vi } from 'vitest';
import { WakeLockManager } from '../../src/utils/wake-lock';

/** Fake sentinel capturing its release listener so tests can fire OS releases. */
function makeSentinel() {
  let onRelease: (() => void) | null = null;
  const sentinel = {
    release: vi.fn(async () => {
      onRelease?.();
    }),
    addEventListener: vi.fn((type: string, cb: () => void) => {
      if (type === 'release') onRelease = cb;
    }),
    /** Simulate the OS auto-releasing (tab hidden, battery saver…). */
    osRelease: () => onRelease?.(),
  };
  return sentinel;
}

function makeWakeLock() {
  const sentinels: ReturnType<typeof makeSentinel>[] = [];
  const wakeLock = {
    request: vi.fn(async (_type?: string) => {
      const s = makeSentinel();
      sentinels.push(s);
      return s as unknown as WakeLockSentinel;
    }),
  };
  return { wakeLock: wakeLock as unknown as WakeLock, raw: wakeLock, sentinels };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('WakeLockManager', () => {
  it('acquires a screen lock on enable and releases on disable', async () => {
    const { wakeLock, raw, sentinels } = makeWakeLock();
    const m = new WakeLockManager({ wakeLock, doc: document });
    expect(m.supported).toBe(true);

    m.enable();
    await flush();
    expect(raw.request).toHaveBeenCalledWith('screen');
    expect(sentinels).toHaveLength(1);

    m.disable();
    await flush();
    expect(sentinels[0]!.release).toHaveBeenCalled();
  });

  it('re-acquires on visibilitychange after the OS auto-released it', async () => {
    const { wakeLock, raw, sentinels } = makeWakeLock();
    const m = new WakeLockManager({ wakeLock, doc: document });

    m.enable();
    await flush();
    expect(raw.request).toHaveBeenCalledTimes(1);

    // OS releases the lock (tab hidden); manager still wants it.
    sentinels[0]!.osRelease();
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(raw.request).toHaveBeenCalledTimes(2);
  });

  it('does not re-acquire on visibilitychange after disable', async () => {
    const { wakeLock, raw, sentinels } = makeWakeLock();
    const m = new WakeLockManager({ wakeLock, doc: document });

    m.enable();
    await flush();
    m.disable();
    sentinels[0]!.osRelease();
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(raw.request).toHaveBeenCalledTimes(1);
  });

  it('releases a lock that resolves after disable() raced it', async () => {
    const { wakeLock, sentinels } = makeWakeLock();
    const m = new WakeLockManager({ wakeLock, doc: document });

    m.enable();
    m.disable(); // request still in flight
    await flush();
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.release).toHaveBeenCalled();
  });

  it('is a silent no-op when wakeLock is unsupported', () => {
    const m = new WakeLockManager({ wakeLock: undefined, doc: document });
    expect(m.supported).toBe(false);
    expect(() => {
      m.enable();
      m.disable();
    }).not.toThrow();
  });

  it('swallows request rejections', async () => {
    const wakeLock = {
      request: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    } as unknown as WakeLock;
    const m = new WakeLockManager({ wakeLock, doc: document });
    m.enable();
    await flush();
    // No unhandled rejection; a later visibilitychange retries.
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
  });
});
