/**
 * Performance mode — a device-scoped audio-quality preference, in three tiers.
 *
 * This is deliberately **not** a `ParamBus` param: it tunes the runtime for the
 * machine the app happens to be running on (audio buffer size, voice count,
 * scope cost), so it must NOT be captured into presets or song files. It is
 * stored on its own under the `websynth.*` convention, mirroring the
 * `localStorage` try/catch pattern in `ui/components/collapse-toggle.ts`.
 *
 * `PERF_PROFILES` is the single source of truth for every tier-dependent knob.
 * The two *audio* fields (`latencyHint`, `voiceCount`) can only be chosen when
 * the `AudioContext`/voice pool are built, so they are read once at boot
 * (`main.ts`) — changing across an audio boundary takes full effect on reload.
 * `fps` is applied live by the scope (see `ui/components/scope.ts`).
 */

const STORE_KEY = 'websynth.perf';

export type PerfTier = 'weak' | 'medium' | 'strong';
export type PerfPref = 'auto' | PerfTier;

export interface PerfProfile {
  /** AudioContext buffer hint; 'playback' trades latency for a larger, glitch-resistant buffer. */
  latencyHint: AudioContextLatencyCategory;
  /** Voice-pool size — fewer per-voice ladder filters is the biggest steady-state CPU saving. */
  voiceCount: number;
  /** Scope target frame rate (applied live). */
  fps: number;
  /** Transport look-ahead horizon (s) — wider absorbs slow wakeups on throttled devices. */
  scheduleAheadS: number;
  /** Longest reverb IR the banks render (s) — caps always-on convolution cost. */
  reverbIrMaxS: number;
  /** Allow WaveShaper oversampling (synth/sampler distortion 4x, drum tracks 2x). */
  fxOversample: boolean;
  /** fftSize of the 3 scope analysers — smaller cuts always-on FFT + per-draw copy cost. */
  analyserFftSize: number;
}

/** The single source of truth for every tier-dependent knob. */
export const PERF_PROFILES: Record<PerfTier, PerfProfile> = {
  weak: { latencyHint: 'playback', voiceCount: 5, fps: 15, scheduleAheadS: 0.2, reverbIrMaxS: 1.5, fxOversample: false, analyserFftSize: 512 },
  medium: { latencyHint: 'interactive', voiceCount: 8, fps: 30, scheduleAheadS: 0.1, reverbIrMaxS: 4, fxOversample: true, analyserFftSize: 1024 },
  strong: { latencyHint: 'interactive', voiceCount: 8, fps: 60, scheduleAheadS: 0.1, reverbIrMaxS: 4, fxOversample: true, analyserFftSize: 2048 },
};

const TIERS: readonly PerfTier[] = ['weak', 'medium', 'strong'];

/** Stored preference, defaulting to 'auto'. Migrates legacy v1 values on read. */
export function readPerfPref(): PerfPref {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === 'auto' || (v && (TIERS as readonly string[]).includes(v))) return v as PerfPref;
    // Legacy v1 values: 'on' was the reduced profile (~weak), 'off' was full (~strong).
    if (v === 'on') return 'weak';
    if (v === 'off') return 'strong';
    return 'auto';
  } catch {
    return 'auto';
  }
}

export function writePerfPref(pref: PerfPref): void {
  try {
    localStorage.setItem(STORE_KEY, pref);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

function navMemoryGb(): number | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof mem === 'number' ? mem : undefined;
}

/** Phone user agent (intentionally excludes `iPad` — modern iPads are not weak). */
function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent || '');
}

/**
 * Classify the device into a tier. Errs toward `medium` (normal latency): a tier
 * is only `weak` on a genuinely low signal and only `strong` when clearly high-end
 * and not a phone. Detection is a hint (`deviceMemory` is Chrome-only, cores can be
 * capped) — the user override is the real escape hatch.
 */
export function detectTier(): PerfTier {
  if (typeof navigator === 'undefined') return 'medium';
  const cores = navigator.hardwareConcurrency ?? 0;
  const mem = navMemoryGb();
  const mobile = isMobileUA();

  // Weak — genuinely low-end.
  if (cores > 0 && cores <= 2) return 'weak';
  if (typeof mem === 'number' && mem <= 2) return 'weak';
  if (mobile && (cores <= 4 || (typeof mem === 'number' && mem <= 4))) return 'weak';

  // Strong — clearly high-end, not a phone.
  if (!mobile && cores >= 8 && (mem === undefined || mem >= 8)) return 'strong';

  return 'medium';
}

/** The effective tier — a concrete preference passes through; `auto` is detected. */
export function resolveTier(pref: PerfPref = readPerfPref()): PerfTier {
  return pref === 'auto' ? detectTier() : pref;
}

/** Two tiers need a reload between them iff any boot-time audio field differs. */
export function sameAudioProfile(a: PerfTier, b: PerfTier): boolean {
  const x = PERF_PROFILES[a];
  const y = PERF_PROFILES[b];
  return (
    x.latencyHint === y.latencyHint &&
    x.voiceCount === y.voiceCount &&
    x.scheduleAheadS === y.scheduleAheadS &&
    x.reverbIrMaxS === y.reverbIrMaxS &&
    x.fxOversample === y.fxOversample &&
    x.analyserFftSize === y.analyserFftSize
  );
}

export interface PerfDiagnostics {
  /** navigator.hardwareConcurrency, or null if unavailable. */
  cores: number | null;
  /** navigator.deviceMemory in GB (Chrome-only; null elsewhere). */
  memoryGb: number | null;
  /** Whether the UA looks like a phone (the same test `detectTier` uses). */
  mobile: boolean;
  /** Stored preference. */
  pref: PerfPref;
  /** What `auto` would pick on this device. */
  detected: PerfTier;
  /** The effective tier (pref resolved). */
  tier: PerfTier;
  /** The active profile (`PERF_PROFILES[tier]`). */
  profile: PerfProfile;
}

/** Device diagnostics for the About → Debug panel (reuses the detection above). */
export function perfDiagnostics(): PerfDiagnostics {
  const cores = typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
    ? navigator.hardwareConcurrency
    : null;
  const mem = navMemoryGb();
  const pref = readPerfPref();
  const tier = resolveTier(pref);
  return {
    cores,
    memoryGb: mem ?? null,
    mobile: isMobileUA(),
    pref,
    detected: detectTier(),
    tier,
    profile: PERF_PROFILES[tier],
  };
}
