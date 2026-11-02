import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import {
  TRANSPORT_WIDTH_KEY, XY_PAD_SIZE_KEY,
  readSizePref, writeSizePref, clearSizePref,
} from '../../src/state/size-pref';

/**
 * A remembered on-screen size — the scope row (via scope-height.ts),
 * transport-window.md REQ-the-window-width-is-resizable and xy-pad.md
 * REQ-the-pad-is-resizable.
 */
describe('size preference store', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = installLocalStorageMock(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('uses the two keys the specs name', () => {
    expect(TRANSPORT_WIDTH_KEY).toBe('websynth.ui.window.transport.width');
    expect(XY_PAD_SIZE_KEY).toBe('websynth.ui.window.xypad.size');
  });

  it('round-trips a size, rounded to whole px', () => {
    writeSizePref(XY_PAD_SIZE_KEY, 480.6);
    expect(store.get(XY_PAD_SIZE_KEY)).toBe('481');
    expect(readSizePref(XY_PAD_SIZE_KEY, 240, 960)).toBe(481);
  });

  it('nothing stored is null — the automatic size', () => {
    expect(readSizePref(TRANSPORT_WIDTH_KEY, 160, 8192)).toBeNull();
  });

  it('clamps a stored value into the range on read', () => {
    store.set(XY_PAD_SIZE_KEY, '5000');
    expect(readSizePref(XY_PAD_SIZE_KEY, 240, 960)).toBe(960);
    store.set(XY_PAD_SIZE_KEY, '10');
    expect(readSizePref(XY_PAD_SIZE_KEY, 240, 960)).toBe(240);
  });

  it('garbage reads as null, never as a size', () => {
    store.set(XY_PAD_SIZE_KEY, 'wide');
    expect(readSizePref(XY_PAD_SIZE_KEY, 240, 960)).toBeNull();
  });

  it('clear forgets the size', () => {
    writeSizePref(TRANSPORT_WIDTH_KEY, 1200);
    clearSizePref(TRANSPORT_WIDTH_KEY);
    expect(store.has(TRANSPORT_WIDTH_KEY)).toBe(false);
  });

  it('never writes a non-finite size', () => {
    writeSizePref(TRANSPORT_WIDTH_KEY, Number.NaN);
    expect(store.has(TRANSPORT_WIDTH_KEY)).toBe(false);
  });

  it('a storage that throws costs the preference, not the app', () => {
    const boom = (): never => { throw new Error('denied'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(readSizePref(XY_PAD_SIZE_KEY, 240, 960)).toBeNull();
    expect(() => writeSizePref(XY_PAD_SIZE_KEY, 480)).not.toThrow();
    expect(() => clearSizePref(XY_PAD_SIZE_KEY)).not.toThrow();
  });
});
