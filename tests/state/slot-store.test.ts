import { describe, it, expect, afterEach, vi } from 'vitest';
import { SlotStore } from '../../src/state/slot-store';

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
