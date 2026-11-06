// The UI scale's stops, stored value and engine choice (specs/features/ui-scale.md).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import { readSource } from '../css-source';
import {
  UI_SCALE_STOPS,
  UI_SCALE_DEFAULT,
  UI_SCALE_KEY,
  ENGINE_QUERY,
  SHIPPED_VIEWPORT,
  isScaleStop,
  readUiScale,
  writeUiScale,
  pickEngine,
  scaledViewport,
} from '../../src/state/ui-scale';

let store: Map<string, string>;
beforeEach(() => {
  store = installLocalStorageMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the stops (REQ-the-scale-snaps-to-browser-steps)', () => {
  it("are the browser's zoom steps from 50 to 150, ascending, with 100 the default", () => {
    expect([...UI_SCALE_STOPS]).toEqual([50, 67, 75, 80, 90, 100, 110, 125, 150]);
    expect(UI_SCALE_DEFAULT).toBe(100);
    expect(UI_SCALE_STOPS).toContain(UI_SCALE_DEFAULT);
  });
});

describe('the stored value (REQ-the-scale-is-a-device-preference)', () => {
  it('reads 100 with nothing stored', () => {
    expect(readUiScale()).toBe(100);
  });

  it('restores every stop', () => {
    for (const s of UI_SCALE_STOPS) {
      writeUiScale(s);
      expect(readUiScale()).toBe(s);
    }
  });

  it('stores 100 as the absence of the key', () => {
    writeUiScale(125);
    expect(store.get(UI_SCALE_KEY)).toBe('125');
    writeUiScale(100);
    expect(store.has(UI_SCALE_KEY)).toBe(false);
  });

  it('reads anything that is not exactly a stop as 100 (edge, untrusted-input)', () => {
    for (const v of ['9999', 'abc', '120', '', ' 125', '125.0', '1.25', '-50', 'NaN', 'Infinity', '__proto__']) {
      store.set(UI_SCALE_KEY, v);
      expect(readUiScale(), JSON.stringify(v)).toBe(100);
    }
  });

  it('never writes a value that is not a stop', () => {
    writeUiScale(120);
    expect(store.has(UI_SCALE_KEY)).toBe(false);
    expect(isScaleStop(120)).toBe(false);
    expect(isScaleStop(125)).toBe(true);
    expect(isScaleStop('125')).toBe(false);
  });

  it('reads 100 and writes nothing when storage is blocked (edge)', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    vi.stubGlobal('localStorage', throwing);
    expect(readUiScale()).toBe(100);
    expect(() => writeUiScale(125)).not.toThrow();
    expect(() => writeUiScale(100)).not.toThrow();
  });
});

describe('the engine (REQ-one-value-two-engines)', () => {
  it('is viewport on a touch-first device and zoom everywhere else', () => {
    expect(pickEngine((q) => q === ENGINE_QUERY)).toBe('viewport');
    expect(pickEngine(() => false)).toBe('zoom');
  });

  it('rewrites the viewport with a fixed scale and no width', () => {
    expect(scaledViewport(80)).toBe('initial-scale=0.8, minimum-scale=0.8, maximum-scale=0.8, viewport-fit=cover, user-scalable=no');
    expect(scaledViewport(125)).not.toContain('width');
  });
});

describe('the shipped tag (REQ-a-hundred-percent-is-a-no-op)', () => {
  it("is index.html's viewport content, so 100% restores exactly what shipped", () => {
    const m = /<meta name="viewport" content="([^"]*)"/.exec(readSource('index.html'));
    expect(m, 'index.html has a viewport meta').not.toBeNull();
    expect(SHIPPED_VIEWPORT).toBe(m![1]);
  });
});
