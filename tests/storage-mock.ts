import { vi } from 'vitest';

/**
 * jsdom's localStorage isn't reliably wired under Vitest, so suites that touch
 * it install a tiny in-memory Storage (same approach as `state/song.test.ts`).
 * Call from `beforeEach`; returns the backing map for direct inspection.
 */
function installStorageMock(globalName: 'localStorage' | 'sessionStorage'): Map<string, string> {
  const store = new Map<string, string>();
  const mock: Storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal(globalName, mock);
  return store;
}

export function installLocalStorageMock(): Map<string, string> {
  return installStorageMock('localStorage');
}

export function installSessionStorageMock(): Map<string, string> {
  return installStorageMock('sessionStorage');
}
