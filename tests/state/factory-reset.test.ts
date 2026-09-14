import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { restoreFactorySettings, type FactoryResetDeps } from '../../src/state/factory-reset';
import { OFFLINE_REDOWNLOAD_KEY } from '../../src/state/offline-redownload';
import { OFFLINE_MARKER_URL, offlineCacheName } from '../../src/utils/offline-copy';
import { installLocalStorageMock, installSessionStorageMock } from '../storage-mock';
import { FakeCacheStorage } from '../fixtures/offline-fakes';

describe('restoreFactorySettings', () => {
  let local: Map<string, string>;
  let session: Map<string, string>;

  beforeEach(() => {
    local = installLocalStorageMock();
    session = installSessionStorageMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears both storages and then reloads', async () => {
    local.set('websynth.preset.index', '[]');
    local.set('websynth.perf', 'strong');
    session.set('some.session.key', '1');

    const reload = vi.fn();
    await restoreFactorySettings(reload);

    expect(local.size).toBe(0);
    expect(session.size).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when a storage clear throws', async () => {
    vi.stubGlobal('localStorage', {
      clear: () => { throw new Error('blocked'); },
    } as unknown as Storage);
    session.set('k', 'v');

    const reload = vi.fn();
    await restoreFactorySettings(reload);

    expect(session.size).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // REQ-9: the sampler-clip store (IndexedDB) is wiped too. jsdom has no
  // IndexedDB, so this also pins that its absence is a silent no-op rather
  // than something that can strand the reload.
  it('reloads even though IndexedDB is unavailable (clip wipe is best-effort)', async () => {
    const reload = vi.fn();
    await restoreFactorySettings(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// ---- v5: the offline copy (REQ-8, REQ-9) ----

describe('restoreFactorySettings and the offline copy', () => {
  let session: Map<string, string>;

  beforeEach(() => {
    installLocalStorageMock();
    session = installSessionStorageMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const reachable = () => vi.fn(async () => new Response(null, { status: 200 }));

  /** Run the reset; report the session storage as the reload saw it. */
  async function reset(deps: FactoryResetDeps) {
    let sessionAtReload: [string, string][] = [];
    const reload = vi.fn(() => { sessionAtReload = [...session.entries()]; });
    await restoreFactorySettings(reload, deps);
    return { reload, sessionAtReload };
  }

  it('deletes a saved copy with every app cache and asks for it back (REQ-8)', async () => {
    session.set('websynth.session.tab', 'abc');
    const storage = FakeCacheStorage.with({
      [offlineCacheName('1.0.0')]: [OFFLINE_MARKER_URL, '/'],
      [offlineCacheName('0.9.0')]: ['/'],
      'not-ours': ['/x'],
    });
    const fetch = reachable();

    const { reload, sessionAtReload } = await reset({ caches: storage.asCacheStorage, fetch });

    expect([...storage.caches.keys()]).toEqual(['not-ours']);
    // The probe is a HEAD, so the worker passes it to the network (REQ-9).
    expect(fetch).toHaveBeenCalledWith('/', expect.objectContaining({ method: 'HEAD', cache: 'no-store' }));
    // Written after the clear: the intent is the only thing that survives.
    expect(sessionAtReload).toEqual([[OFFLINE_REDOWNLOAD_KEY, '1']]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('deletes runtime caches without asking for a download (REQ-8)', async () => {
    const storage = FakeCacheStorage.with({ [offlineCacheName('1.0.0')]: ['/', '/assets/a.js'] });
    const { sessionAtReload } = await reset({ caches: storage.asCacheStorage, fetch: reachable() });
    expect(storage.caches.size).toBe(0);
    expect(sessionAtReload).toEqual([]);
  });

  it('keeps every cache when the server cannot be reached (REQ-9)', async () => {
    const storage = FakeCacheStorage.with({ [offlineCacheName('1.0.0')]: [OFFLINE_MARKER_URL, '/'] });
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });

    const { reload, sessionAtReload } = await reset({ caches: storage.asCacheStorage, fetch });

    expect([...storage.caches.keys()]).toEqual([offlineCacheName('1.0.0')]);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(sessionAtReload).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not probe the server when there is no app cache to delete', async () => {
    const storage = FakeCacheStorage.with({ 'not-ours': ['/x'] });
    const fetch = reachable();
    await reset({ caches: storage.asCacheStorage, fetch });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reloads after the cap when the Cache API hangs, without an intent (REQ-9)', async () => {
    vi.useFakeTimers();
    const cacheStorage = { keys: () => new Promise<string[]>(() => {}) } as unknown as CacheStorage;
    let sessionAtReload: [string, string][] | null = null;
    const reload = vi.fn(() => { sessionAtReload = [...session.entries()]; });

    const done = restoreFactorySettings(reload, { caches: cacheStorage, fetch: reachable() });
    await vi.advanceTimersByTimeAsync(3999);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionAtReload).toEqual([]);
  });
});
