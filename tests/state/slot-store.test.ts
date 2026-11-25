import { describe, it, expect, afterEach, vi } from 'vitest';
import { SlotStore } from '../../src/state/slot-store';
import { installLocalStorageMock } from '../storage-mock';

/**
 * storage-failures.md REQ-a-slot-read-never-throws: a browser that blocks storage
 * throws on every access. Reads treat that as empty; writes still throw, so the
 * caller can report a refused save (REQ-a-failed-save-says-so).
 */
describe('SlotStore over blocked storage', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const blocked = (): void => {
    const refuse = (): never => { throw new DOMException('refused', 'SecurityError'); };
    vi.stubGlobal('localStorage', {
      getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse, key: refuse,
      get length(): number { return refuse(); },
    });
  };

  it('reads as empty', () => {
    blocked();
    const store = new SlotStore('websynth.test.');
    expect(store.readIndex()).toEqual([]);
    expect(store.readRaw('anything')).toBeNull();
  });

  it('still throws on a write, for the caller to report', () => {
    blocked();
    const store = new SlotStore('websynth.test.');
    expect(() => store.writeRaw('song', '{}')).toThrow();
  });
});

// storage-failures.md REQ-a-slot-read-never-throws: a slot and its index entry land
// together or not at all, so a save reported as failed leaves nothing behind.
describe('SlotStore.save', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  /** Storage that accepts slot writes and refuses the index write. */
  function refuseIndex(prefix: string): Map<string, string> {
    const map = installLocalStorageMock();
    const set = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
      if (k === prefix + 'index') throw new DOMException('full', 'QuotaExceededError');
      set(k, v);
    });
    return map;
  }

  it('takes a new slot back out when its index write is refused', () => {
    const map = refuseIndex('websynth.test.');
    const store = new SlotStore('websynth.test.');
    expect(() => store.save('song', '{"a":1}')).toThrow();
    expect(map.has('websynth.test.song')).toBe(false);
  });

  it('puts an existing slot back as it was', () => {
    const map = refuseIndex('websynth.test.');
    map.set('websynth.test.song', '{"old":true}');
    const store = new SlotStore('websynth.test.');
    expect(() => store.save('song', '{"new":true}')).toThrow();
    expect(map.get('websynth.test.song')).toBe('{"old":true}');
  });

  it('writes both when nothing is refused', () => {
    const map = installLocalStorageMock();
    const store = new SlotStore('websynth.test.');
    store.save('song', '{}');
    expect(map.get('websynth.test.song')).toBe('{}');
    expect(store.readIndex()).toEqual(['song']);
  });
});
