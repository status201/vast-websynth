import { describe, it, expect, afterEach, vi } from 'vitest';
import { isIOS } from '../../src/platform/ios';

/** Minimal navigator stub for the detection branches. */
function stubNavigator(fields: { userAgent?: string; platform?: string; maxTouchPoints?: number }): void {
  vi.stubGlobal('navigator', { userAgent: '', platform: '', maxTouchPoints: 0, ...fields });
}

describe('isIOS', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true for an iPhone user agent', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    expect(isIOS()).toBe(true);
  });

  it('is true for an iPad / iPod user agent', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)' });
    expect(isIOS()).toBe(true);
  });

  it('is true for iPadOS desktop mode (MacIntel + multi-touch)', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
  });

  it('is false on a real Mac (MacIntel, no touch)', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 });
    expect(isIOS()).toBe(false);
  });

  it('is false on Windows and Android', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' });
    expect(isIOS()).toBe(false);
    stubNavigator({ userAgent: 'Mozilla/5.0 (Linux; Android 13)', platform: 'Linux armv8l', maxTouchPoints: 5 });
    expect(isIOS()).toBe(false);
  });
});
