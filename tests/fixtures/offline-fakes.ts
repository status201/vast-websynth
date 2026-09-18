import { vi } from 'vitest';
import type { OfflineCopy, OfflineState } from '../../src/utils/offline-copy';

/**
 * In-memory stand-ins for the Play offline suites (specs/features/play-offline.md),
 * shared by the downloader, factory-reset and notices tests so each does not
 * grow its own. (`tests/pwa/sw.test.ts` keeps its own fake: it stubs the worker's
 * globals and stores plain objects it compares by identity.)
 */

/**
 * One named cache: url → Response. `match` hands out clones, as the real cache
 * hands out fresh responses, and a stored response carrying `Vary` misses
 * unless the lookup passes `ignoreVary` — the real cache compares request
 * headers a URL-only lookup does not carry (REQ-cache-lookups-ignore-vary).
 */
export class FakeCache {
  readonly store = new Map<string, Response>();
  /** Thrown by every `put` while set (a full disk: name it `QuotaExceededError`). */
  putError: Error | null = null;

  async match(url: string, opts?: CacheQueryOptions): Promise<Response | undefined> {
    const hit = this.store.get(url);
    if (hit?.headers.has('Vary') && !opts?.ignoreVary) return undefined;
    return hit?.clone();
  }

  async put(url: string, res: Response): Promise<void> {
    if (this.putError) throw this.putError;
    this.store.set(url, res);
  }
}

/** Named `FakeCache`s behind the CacheStorage calls the app makes. */
export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  /** `{ 'websynth-1.0.0': ['/', '/__offline-copy'] }` — each url cached with a plain body. */
  static with(entries: Record<string, string[]>): FakeCacheStorage {
    const storage = new FakeCacheStorage();
    for (const [name, urls] of Object.entries(entries)) {
      const cache = storage.cache(name);
      for (const url of urls) cache.store.set(url, new Response(`cached ${url}`));
    }
    return storage;
  }

  /** The cache called `name`, created empty on first use. */
  cache(name: string): FakeCache {
    let c = this.caches.get(name);
    if (!c) {
      c = new FakeCache();
      this.caches.set(name, c);
    }
    return c;
  }

  readonly keys = vi.fn(async (): Promise<string[]> => [...this.caches.keys()]);
  readonly open = vi.fn(async (name: string): Promise<FakeCache> => this.cache(name));
  readonly delete = vi.fn(async (name: string): Promise<boolean> => this.caches.delete(name));

  get asCacheStorage(): CacheStorage {
    return this as unknown as CacheStorage;
  }
}

/** An `OfflineCopy` whose state a test drives by hand with `emit`. */
export class StubOfflineCopy {
  state: OfflineState = { kind: 'checking' };
  private readonly fns = new Set<(s: OfflineState) => void>();
  readonly start = vi.fn(async () => {});
  readonly cancel = vi.fn();
  readonly refresh = vi.fn(async () => {});

  subscribe(fn: (s: OfflineState) => void): () => void {
    this.fns.add(fn);
    return () => { this.fns.delete(fn); };
  }

  emit(s: OfflineState): void {
    this.state = s;
    for (const fn of this.fns) fn(s);
  }

  get asCopy(): OfflineCopy {
    return this as unknown as OfflineCopy;
  }
}
