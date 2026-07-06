import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import {
  readPerfPref,
  writePerfPref,
  detectTier,
  resolveTier,
  sameAudioProfile,
  perfDiagnostics,
  PERF_PROFILES,
} from '../../src/state/perf-mode';

/** Replace `navigator` with a minimal stub for the detection branches. */
function stubNavigator(fields: { hardwareConcurrency?: number; deviceMemory?: number; userAgent?: string }): void {
  vi.stubGlobal('navigator', { userAgent: '', ...fields });
}

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; SM-G960)';
// Modern iPads report a desktop-class UA (no Mobi/iPhone token).
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/17.0 Safari/605';

describe('perf-mode preference storage', () => {
  beforeEach(() => installLocalStorageMock());
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to auto when nothing is stored', () => {
    expect(readPerfPref()).toBe('auto');
  });

  it('round-trips auto / weak / medium / strong', () => {
    for (const v of ['auto', 'weak', 'medium', 'strong'] as const) {
      writePerfPref(v);
      expect(readPerfPref()).toBe(v);
    }
  });

  it('migrates legacy v1 values (on→weak, off→strong)', () => {
    localStorage.setItem('websynth.perf', 'on');
    expect(readPerfPref()).toBe('weak');
    localStorage.setItem('websynth.perf', 'off');
    expect(readPerfPref()).toBe('strong');
  });

  it('falls back to auto for an unrecognised stored value', () => {
    localStorage.setItem('websynth.perf', 'garbage');
    expect(readPerfPref()).toBe('auto');
  });
});

describe('detectTier', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is weak with very few cores', () => {
    stubNavigator({ hardwareConcurrency: 2, userAgent: DESKTOP });
    expect(detectTier()).toBe('weak');
  });

  it('is weak with very little memory', () => {
    stubNavigator({ hardwareConcurrency: 8, deviceMemory: 2, userAgent: DESKTOP });
    expect(detectTier()).toBe('weak');
  });

  it('is weak for a phone with few cores', () => {
    stubNavigator({ hardwareConcurrency: 4, userAgent: ANDROID });
    expect(detectTier()).toBe('weak');
  });

  it('is weak for a phone with little memory', () => {
    stubNavigator({ hardwareConcurrency: 6, deviceMemory: 3, userAgent: IPHONE });
    expect(detectTier()).toBe('weak');
  });

  it('is strong on a capable desktop', () => {
    stubNavigator({ hardwareConcurrency: 12, deviceMemory: 16, userAgent: DESKTOP });
    expect(detectTier()).toBe('strong');
  });

  it('is strong on a desktop with many cores and no memory signal', () => {
    stubNavigator({ hardwareConcurrency: 8, userAgent: DESKTOP });
    expect(detectTier()).toBe('strong');
  });

  it('is medium for an in-between desktop', () => {
    stubNavigator({ hardwareConcurrency: 6, deviceMemory: 8, userAgent: DESKTOP });
    expect(detectTier()).toBe('medium');
  });

  it('does not force a capable iPad-class device to weak (the v1 regression)', () => {
    stubNavigator({ hardwareConcurrency: 8, userAgent: IPAD_DESKTOP });
    expect(detectTier()).not.toBe('weak');
  });

  it('defaults a modern phone (many cores, no memory signal) to medium, not weak', () => {
    stubNavigator({ hardwareConcurrency: 8, userAgent: IPHONE });
    expect(detectTier()).toBe('medium');
  });
});

describe('resolveTier', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes a concrete tier through, ignoring the device', () => {
    stubNavigator({ hardwareConcurrency: 12, deviceMemory: 16, userAgent: DESKTOP }); // strong device
    expect(resolveTier('weak')).toBe('weak');
    stubNavigator({ hardwareConcurrency: 1, userAgent: IPHONE }); // weak device
    expect(resolveTier('strong')).toBe('strong');
  });

  it('auto follows device detection', () => {
    stubNavigator({ hardwareConcurrency: 2, userAgent: DESKTOP });
    expect(resolveTier('auto')).toBe('weak');
    stubNavigator({ hardwareConcurrency: 12, deviceMemory: 16, userAgent: DESKTOP });
    expect(resolveTier('auto')).toBe('strong');
  });
});

describe('sameAudioProfile', () => {
  it('medium and strong share an audio profile (scope fps + fftSize differ, both live)', () => {
    expect(sameAudioProfile('medium', 'strong')).toBe(true);
  });

  it('weak differs from medium and strong (buffer + voices + FX cost)', () => {
    expect(sameAudioProfile('weak', 'medium')).toBe(false);
    expect(sameAudioProfile('weak', 'strong')).toBe(false);
  });

  it('a tier equals itself', () => {
    expect(sameAudioProfile('weak', 'weak')).toBe(true);
  });
});

describe('PERF_PROFILES v3 FX-cost fields', () => {
  it('weak widens the look-ahead and caps FX cost; medium/strong stay full', () => {
    expect(PERF_PROFILES.weak).toMatchObject({ scheduleAheadS: 0.2, reverbIrMaxS: 1.5, fxOversample: false });
    expect(PERF_PROFILES.medium).toMatchObject({ scheduleAheadS: 0.1, reverbIrMaxS: 4, fxOversample: true });
    expect(PERF_PROFILES.strong).toMatchObject({ scheduleAheadS: 0.1, reverbIrMaxS: 4, fxOversample: true });
  });
});

describe('PERF_PROFILES v4/v5 analyser fftSize (applied live)', () => {
  it('scales the analyser fftSize per tier (512 / 1024 / 2048)', () => {
    expect(PERF_PROFILES.weak.analyserFftSize).toBe(512);
    expect(PERF_PROFILES.medium.analyserFftSize).toBe(1024);
    expect(PERF_PROFILES.strong.analyserFftSize).toBe(2048);
  });

  it('is excluded from sameAudioProfile (live), so medium/strong still share one profile', () => {
    // fftSize differs (1024 vs 2048) yet the audio profile is identical.
    expect(sameAudioProfile('medium', 'strong')).toBe(true);
    expect(sameAudioProfile('weak', 'medium')).toBe(false);
  });
});

describe('perfDiagnostics', () => {
  beforeEach(() => installLocalStorageMock());
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces the raw signals and the resolved tier', () => {
    stubNavigator({ hardwareConcurrency: 12, deviceMemory: 16, userAgent: DESKTOP });
    const d = perfDiagnostics();
    expect(d.cores).toBe(12);
    expect(d.memoryGb).toBe(16);
    expect(d.mobile).toBe(false);
    expect(d.pref).toBe('auto');
    expect(d.detected).toBe('strong');
    expect(d.tier).toBe('strong');
    expect(d.profile).toEqual(PERF_PROFILES.strong);
  });

  it('reports memoryGb as null when deviceMemory is unavailable', () => {
    stubNavigator({ hardwareConcurrency: 8, userAgent: DESKTOP });
    expect(perfDiagnostics().memoryGb).toBeNull();
  });

  it('reflects a forced preference', () => {
    stubNavigator({ hardwareConcurrency: 12, deviceMemory: 16, userAgent: DESKTOP });
    writePerfPref('weak');
    const d = perfDiagnostics();
    expect(d.pref).toBe('weak');
    expect(d.tier).toBe('weak');
    expect(d.profile.fps).toBe(15);
  });
});
