import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import { readSyncMode, writeSyncMode } from '../../src/state/sync-mode';

describe('sync-mode persistence', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageMock();
  });

  it('defaults to off when nothing is stored', () => {
    expect(readSyncMode()).toBe('off');
  });

  it('round-trips every mode under websynth.midisync', () => {
    for (const m of ['off', 'master', 'slave'] as const) {
      writeSyncMode(m);
      expect(store.get('websynth.midisync')).toBe(m);
      expect(readSyncMode()).toBe(m);
    }
  });

  it('reads bad stored values as off', () => {
    store.set('websynth.midisync', 'bogus');
    expect(readSyncMode()).toBe('off');
  });

  it('survives a throwing localStorage (private mode / quota)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    });
    expect(readSyncMode()).toBe('off');
    expect(() => writeSyncMode('master')).not.toThrow();
  });
});
