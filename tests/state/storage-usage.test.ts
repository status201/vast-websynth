import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storageUsage } from '../../src/state/slot-store';
import { installLocalStorageMock } from '../storage-mock';

/** debug-panel.md — the Debug panel's "Local storage" row. */
describe('storageUsage', () => {
  beforeEach(() => { installLocalStorageMock(); });

  it('counts only this app\'s keys, billing key + value characters', () => {
    localStorage.setItem('websynth.a', '12345'); // 10 + 5
    localStorage.setItem('websynth.b', '1');     // 10 + 1
    localStorage.setItem('other.thing', 'ignored me');
    expect(storageUsage()).toEqual({ keys: 2, bytes: 26 });
  });

  it('reports zero on an empty origin, and honours a custom prefix', () => {
    expect(storageUsage()).toEqual({ keys: 0, bytes: 0 });
    localStorage.setItem('websynth.preset.x', '{}');
    expect(storageUsage('websynth.preset.')).toEqual({ keys: 1, bytes: 19 });
    expect(storageUsage('websynth.song.').keys).toBe(0);
  });

  it('degrades to zero rather than throwing when storage is unavailable (edge)', () => {
    vi.stubGlobal('localStorage', {
      get length(): number { throw new Error('blocked'); },
    } as unknown as Storage);
    expect(storageUsage()).toEqual({ keys: 0, bytes: 0 });
    vi.unstubAllGlobals();
  });
});
