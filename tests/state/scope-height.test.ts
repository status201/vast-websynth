import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import {
  SCOPE_H_MIN,
  SCOPE_H_MAX,
  SCOPE_H_DEFAULT,
  clampScopeHeight,
  readScopeHeight,
  writeScopeHeight,
} from '../../src/state/scope-height';

const KEY = 'websynth.ui.scope.height';

describe('scope height — range', () => {
  it('caps at exactly twice the minimum (the feature\'s promise)', () => {
    expect(SCOPE_H_MAX).toBe(SCOPE_H_MIN * 2);
  });

  it('defaults to the minimum, so a fresh boot looks like it always did', () => {
    expect(SCOPE_H_DEFAULT).toBe(SCOPE_H_MIN);
  });
});

describe('clampScopeHeight', () => {
  it('passes through a value inside the range, rounded to whole px', () => {
    expect(clampScopeHeight(186)).toBe(186);
    expect(clampScopeHeight(186.4)).toBe(186);
    expect(clampScopeHeight(186.6)).toBe(187);
  });

  it('clamps at both ends', () => {
    expect(clampScopeHeight(SCOPE_H_MIN - 1)).toBe(SCOPE_H_MIN);
    expect(clampScopeHeight(-9999)).toBe(SCOPE_H_MIN);
    expect(clampScopeHeight(SCOPE_H_MAX + 1)).toBe(SCOPE_H_MAX);
    expect(clampScopeHeight(9999)).toBe(SCOPE_H_MAX);
  });

  it('keeps the boundaries themselves', () => {
    expect(clampScopeHeight(SCOPE_H_MIN)).toBe(SCOPE_H_MIN);
    expect(clampScopeHeight(SCOPE_H_MAX)).toBe(SCOPE_H_MAX);
  });

  it('resolves non-finite input to the default rather than propagating it', () => {
    expect(clampScopeHeight(Number.NaN)).toBe(SCOPE_H_DEFAULT);
    expect(clampScopeHeight(Number.POSITIVE_INFINITY)).toBe(SCOPE_H_DEFAULT);
    expect(clampScopeHeight(Number.NEGATIVE_INFINITY)).toBe(SCOPE_H_DEFAULT);
  });
});

describe('scope height persistence', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Scenario: The height survives a reload
  it('round-trips a dragged height', () => {
    writeScopeHeight(186);
    expect(store.get(KEY)).toBe('186');
    expect(readScopeHeight()).toBe(186);
  });

  it('clamps on the way in, so an out-of-range value is never stored', () => {
    writeScopeHeight(9999);
    expect(store.get(KEY)).toBe(String(SCOPE_H_MAX));
  });

  // Scenario: A corrupt or out-of-range stored height falls back to something usable
  it('returns the default when nothing is stored', () => {
    expect(readScopeHeight()).toBe(SCOPE_H_DEFAULT);
  });

  it('returns the default for garbage', () => {
    store.set(KEY, 'not-a-number');
    expect(readScopeHeight()).toBe(SCOPE_H_DEFAULT);
  });

  it('clamps a stored value left outside the range by another build', () => {
    store.set(KEY, '4000');
    expect(readScopeHeight()).toBe(SCOPE_H_MAX);
    store.set(KEY, '10');
    expect(readScopeHeight()).toBe(SCOPE_H_MIN);
  });

  it('survives storage that throws (private mode) without escaping an error', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(readScopeHeight()).toBe(SCOPE_H_DEFAULT);
    expect(() => writeScopeHeight(200)).not.toThrow();
  });
});
