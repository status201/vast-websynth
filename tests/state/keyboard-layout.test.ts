import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LAYOUTS, readLayoutPref, writeLayoutPref, resolveLayout, detectLayout,
  primeDetection, onLayoutChange, labelFor, resetDetectionForTests,
  type LayoutId,
} from '../../src/state/keyboard-layout';
import { installLocalStorageMock } from '../storage-mock';

const KEY = 'websynth.keyboard.layout';

/** Stub `navigator.keyboard.getLayoutMap()` with a code→char map. */
function stubKeyboard(entries: Record<string, string> | null): void {
  if (entries === null) {
    delete (navigator as unknown as Record<string, unknown>).keyboard;
    return;
  }
  (navigator as unknown as Record<string, unknown>).keyboard = {
    getLayoutMap: () => Promise.resolve(new Map(Object.entries(entries))),
  };
}

describe('keyboard-layout store (keyboard-layout.md REQ-1/REQ-2)', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageMock();
    resetDetectionForTests();
    stubKeyboard(null);
  });

  it('defaults to auto, which resolves to qwerty before detection', () => {
    expect(readLayoutPref()).toBe('auto');
    expect(resolveLayout()).toBe('qwerty');
  });

  it('round-trips an explicit choice', () => {
    writeLayoutPref('azerty');
    expect(store.get(KEY)).toBe('azerty');
    expect(readLayoutPref()).toBe('azerty');
    expect(resolveLayout()).toBe('azerty');
  });

  it('reads a bad stored value as auto rather than throwing (failure)', () => {
    store.set(KEY, 'klingon');
    expect(readLayoutPref()).toBe('auto');
  });

  it('survives localStorage throwing outright (failure)', () => {
    const boom = () => { throw new Error('private mode'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    expect(readLayoutPref()).toBe('auto');
    expect(() => writeLayoutPref('dvorak')).not.toThrow();
    vi.restoreAllMocks();
  });

  it('every layout tabulates the same set of codes', () => {
    const ids = Object.keys(LAYOUTS) as LayoutId[];
    const reference = Object.keys(LAYOUTS.qwerty.keys).sort();
    for (const id of ids) {
      expect(Object.keys(LAYOUTS[id].keys).sort(), id).toEqual(reference);
    }
  });

  it('maps the bottom-left key to the character each layout prints there', () => {
    expect(LAYOUTS.qwerty.keys.KeyZ).toBe('z');
    expect(LAYOUTS.azerty.keys.KeyZ).toBe('w');
    expect(LAYOUTS.qwertz.keys.KeyZ).toBe('y');
    expect(LAYOUTS.dvorak.keys.KeyZ).toBe(';');
  });

  it('labelFor follows the active layout', () => {
    expect(labelFor('KeyZ')).toBe('z');
    writeLayoutPref('azerty');
    expect(labelFor('KeyZ')).toBe('w');
    expect(labelFor('NoSuchCode')).toBe('');
  });

  it('notifies listeners on write, and stops after unsubscribe (REQ-4)', () => {
    const cb = vi.fn();
    const off = onLayoutChange(cb);
    writeLayoutPref('qwertz');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    writeLayoutPref('dvorak');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('keyboard-layout detection (keyboard-layout.md REQ-3)', () => {
  beforeEach(() => {
    installLocalStorageMock();
    resetDetectionForTests();
  });
  afterEach(() => stubKeyboard(null));

  it('recognises each layout from a couple of codes', async () => {
    stubKeyboard({ KeyQ: 'a', KeyZ: 'w' });
    await expect(detectLayout()).resolves.toBe('azerty');
    stubKeyboard({ KeyQ: 'q', KeyZ: 'y' });
    await expect(detectLayout()).resolves.toBe('qwertz');
    stubKeyboard({ KeyQ: "'", KeyZ: ';' });
    await expect(detectLayout()).resolves.toBe('dvorak');
    stubKeyboard({ KeyQ: 'q', KeyZ: 'z' });
    await expect(detectLayout()).resolves.toBe('qwerty');
  });

  it('is null when the API is absent — detection is a hint, not a gate', async () => {
    stubKeyboard(null);
    await expect(detectLayout()).resolves.toBeNull();
    await primeDetection();
    expect(resolveLayout()).toBe('qwerty'); // auto falls back
  });

  it('is null when getLayoutMap rejects (failure)', async () => {
    (navigator as unknown as Record<string, unknown>).keyboard = {
      getLayoutMap: () => Promise.reject(new Error('nope')),
    };
    await expect(detectLayout()).resolves.toBeNull();
  });

  it('is null for a layout it does not recognise, rather than guessing', async () => {
    stubKeyboard({ KeyQ: 'ф', KeyZ: 'я' }); // Cyrillic — untabulated
    await expect(detectLayout()).resolves.toBeNull();
  });

  it('primes auto so resolveLayout reports the detected layout', async () => {
    stubKeyboard({ KeyQ: 'a', KeyZ: 'w' });
    await primeDetection();
    expect(readLayoutPref()).toBe('auto');
    expect(resolveLayout()).toBe('azerty');
  });

  it('an explicit choice outranks detection (REQ-3)', async () => {
    stubKeyboard({ KeyQ: 'a', KeyZ: 'w' });
    await primeDetection();
    writeLayoutPref('dvorak');
    expect(resolveLayout()).toBe('dvorak');
  });
});
