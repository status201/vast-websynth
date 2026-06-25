import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import {
  readPerfPref,
  writePerfPref,
  detectWeakDevice,
  resolvePerfActive,
} from '../../src/state/perf-mode';

/** Replace `navigator` with a minimal stub for the detection branches. */
function stubNavigator(fields: { hardwareConcurrency?: number; deviceMemory?: number; userAgent?: string }): void {
  vi.stubGlobal('navigator', { userAgent: '', ...fields });
}

describe('perf-mode preference storage', () => {
  beforeEach(() => installLocalStorageMock());
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to auto when nothing is stored', () => {
    expect(readPerfPref()).toBe('auto');
  });

  it('round-trips on / off / auto', () => {
    writePerfPref('on');
    expect(readPerfPref()).toBe('on');
    writePerfPref('off');
    expect(readPerfPref()).toBe('off');
    writePerfPref('auto');
    expect(readPerfPref()).toBe('auto');
  });

  it('falls back to auto for an unrecognised stored value', () => {
    localStorage.setItem('websynth.perf', 'garbage');
    expect(readPerfPref()).toBe('auto');
  });
});

describe('detectWeakDevice', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is weak when there are few logical cores', () => {
    stubNavigator({ hardwareConcurrency: 2, userAgent: 'Desktop' });
    expect(detectWeakDevice()).toBe(true);
  });

  it('is weak when device memory is low', () => {
    stubNavigator({ hardwareConcurrency: 12, deviceMemory: 2, userAgent: 'Desktop' });
    expect(detectWeakDevice()).toBe(true);
  });

  it('is weak for a mobile user agent even with many cores', () => {
    stubNavigator({ hardwareConcurrency: 8, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
    expect(detectWeakDevice()).toBe(true);
  });

  it('is not weak on a capable desktop', () => {
    stubNavigator({ hardwareConcurrency: 12, deviceMemory: 16, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(detectWeakDevice()).toBe(false);
  });
});

describe('resolvePerfActive', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('honours an explicit on / off regardless of the device', () => {
    stubNavigator({ hardwareConcurrency: 12, userAgent: 'Desktop' }); // capable
    expect(resolvePerfActive('on')).toBe(true);
    stubNavigator({ hardwareConcurrency: 1, userAgent: 'iPhone' }); // weak
    expect(resolvePerfActive('off')).toBe(false);
  });

  it('auto follows device capability', () => {
    stubNavigator({ hardwareConcurrency: 2, userAgent: 'Desktop' });
    expect(resolvePerfActive('auto')).toBe(true);
    stubNavigator({ hardwareConcurrency: 12, deviceMemory: 16, userAgent: 'Desktop' });
    expect(resolvePerfActive('auto')).toBe(false);
  });
});
