import { describe, it, expect } from 'vitest';
import { timeStretch, fitToFrames, type StretchMode } from '../../src/audio/recorder/time-stretch';
import {
  MAX_STRETCH_OUTPUT_FRAMES,
  MIN_STRETCH_RATIO,
  MAX_STRETCH_RATIO,
} from '../../src/state/limits';
import type { CapturedAudio } from '../../src/audio/recorder/node';

const SR = 48000;
const MODES: StretchMode[] = ['rhythmic', 'tonal'];

function cap(left: Float32Array, right?: Float32Array, sampleRate = SR): CapturedAudio {
  return { left, right: right ?? left.slice(), sampleRate };
}

/** A steady sine of `hz`, `frames` long. */
function sine(hz: number, frames: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/**
 * Fundamental frequency by autocorrelation, over the buffer's steady middle.
 *
 * Zero-crossing counting is cheaper but rides on DC and on the amplitude ripple an
 * overlap-add leaves behind; autocorrelation measures the period the signal
 * actually repeats at, which is the thing "pitch is preserved" is a claim about.
 */
function estimateHz(x: Float32Array, sampleRate = SR): number {
  const from = Math.floor(x.length * 0.25);
  const to = Math.floor(x.length * 0.75);
  const n = to - from;
  const minLag = Math.floor(sampleRate / 2000);   // 2 kHz ceiling
  const maxLag = Math.floor(sampleRate / 50);     // 50 Hz floor
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let dot = 0;
    let energy = 0;
    for (let i = 0; i + lag < n; i++) {
      dot += x[from + i]! * x[from + i + lag]!;
      energy += x[from + i + lag]! * x[from + i + lag]!;
    }
    const score = energy > 1e-12 ? dot / Math.sqrt(energy) : 0;
    if (score > best) { best = score; bestLag = lag; }
  }
  return sampleRate / bestLag;
}

function peak(x: Float32Array): number {
  let p = 0;
  for (const v of x) { const a = Math.abs(v); if (a > p) p = a; }
  return p;
}

function allFinite(x: Float32Array): boolean {
  for (const v of x) if (!Number.isFinite(v)) return false;
  return true;
}

describe('fitToFrames — length', () => {
  it.each(MODES)('hits the target frame count exactly (%s)', (mode) => {
    const src = cap(sine(220, 40_000));
    // Deliberately not a round multiple of the grain or the hop: a clip one or two
    // frames off the bar is the failure this feature exists to prevent.
    for (const target of [31_337, 40_001, 61_113, 20_000]) {
      const out = fitToFrames(src, target, mode);
      expect(out.left.length).toBe(target);
      expect(out.right.length).toBe(target);
    }
  });

  it('rounds a fractional target rather than refusing it', () => {
    const out = fitToFrames(cap(sine(220, 30_000)), 41_000.4);
    expect(out.left.length).toBe(41_000);
  });
});

describe('fitToFrames — pitch is preserved', () => {
  it.each(MODES)('a 440 Hz sine stretched 2x is twice as long and still 440 Hz (%s)', (mode) => {
    const frames = 48_000;
    const src = cap(sine(440, frames));
    expect(estimateHz(src.left)).toBeCloseTo(440, -1);

    const out = fitToFrames(src, frames * 2, mode);

    expect(out.left.length).toBe(frames * 2);
    // Within a couple of Hz — the estimator quantises to whole-sample lags, which
    // at 440 Hz is already ~4 Hz of resolution.
    expect(estimateHz(out.left)).toBeGreaterThan(430);
    expect(estimateHz(out.left)).toBeLessThan(450);
  });

  it.each(MODES)('a 440 Hz sine compressed to 0.6x still measures 440 Hz (%s)', (mode) => {
    const frames = 48_000;
    const out = fitToFrames(cap(sine(440, frames)), Math.round(frames * 0.6), mode);
    expect(estimateHz(out.left)).toBeGreaterThan(430);
    expect(estimateHz(out.left)).toBeLessThan(450);
  });

  it.each(MODES)('keeps roughly the source level — no overlap-add build-up (%s)', (mode) => {
    const src = cap(sine(300, 40_000));
    const out = fitToFrames(src, 60_000, mode);
    // The window-sum normalisation is what holds this; without it a 4x overlap
    // multiplies the level by ~1.5 (rhythmic) or ~1.1 (tonal).
    expect(peak(out.left)).toBeGreaterThan(0.7);
    expect(peak(out.left)).toBeLessThan(1.35);
  });
});

describe('fitToFrames — the no-op path (REQ-4)', () => {
  it('a target equal to the source length is a clone, sample for sample', () => {
    const src = cap(sine(440, 8192));
    const out = fitToFrames(src, 8192);
    expect(out.left).not.toBe(src.left);
    expect(Array.from(out.left)).toEqual(Array.from(src.left));
    expect(Array.from(out.right)).toEqual(Array.from(src.right));
  });

  it('timeStretch by exactly 1 is a clone', () => {
    const src = cap(sine(440, 8192));
    const out = timeStretch(src, 1);
    expect(out.left).not.toBe(src.left);
    expect(Array.from(out.left)).toEqual(Array.from(src.left));
  });
});

describe('fitToFrames — stability (REQ-6)', () => {
  it.each(MODES)('silence in, silence out, nothing non-finite (%s)', (mode) => {
    const out = fitToFrames(cap(new Float32Array(20_000)), 30_000, mode);
    expect(out.left.length).toBe(30_000);
    expect(allFinite(out.left)).toBe(true);
    expect(allFinite(out.right)).toBe(true);
    expect(peak(out.left)).toBe(0);
  });

  it.each(MODES)('produces nothing non-finite from a hostile input (%s)', (mode) => {
    // Full-scale square edges + DC: the shape most likely to expose a divide by a
    // near-zero window sum.
    const n = 20_000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (i % 97 < 48 ? 1 : -1) * 0.999;
    const out = fitToFrames(cap(x), 33_333, mode);
    expect(allFinite(out.left)).toBe(true);
    expect(peak(out.left)).toBeLessThan(4);
  });

  it('refuses a non-finite, zero or negative target with a clone', () => {
    const src = cap(sine(440, 10_000));
    for (const bad of [NaN, Infinity, -Infinity, 0, -5000]) {
      const out = fitToFrames(src, bad);
      expect(out.left.length).toBe(10_000);
      expect(Array.from(out.left)).toEqual(Array.from(src.left));
    }
  });

  it('refuses a target past MAX_STRETCH_OUTPUT_FRAMES without allocating it', () => {
    const src = cap(sine(440, 10_000));
    const out = fitToFrames(src, MAX_STRETCH_OUTPUT_FRAMES + 1);
    expect(out.left.length).toBe(10_000);
  });

  it('refuses a ratio outside the limits', () => {
    const src = cap(sine(440, 10_000));
    const tooShort = Math.floor(10_000 * MIN_STRETCH_RATIO) - 1;
    const tooLong = Math.ceil(10_000 * MAX_STRETCH_RATIO) + 1;
    expect(fitToFrames(src, tooShort).left.length).toBe(10_000);
    expect(fitToFrames(src, tooLong).left.length).toBe(10_000);
    // …and accepts one just inside.
    expect(fitToFrames(src, 10_000 * 2).left.length).toBe(20_000);
  });

  it('timeStretch refuses a non-finite or non-positive ratio', () => {
    const src = cap(sine(440, 10_000));
    for (const bad of [NaN, Infinity, 0, -2]) {
      expect(fitToFrames(src, bad).left.length).toBe(10_000);
      expect(timeStretch(src, bad).left.length).toBe(10_000);
    }
  });

  it('handles an empty buffer', () => {
    const out = fitToFrames(cap(new Float32Array(0)), 1000);
    expect(out.left.length).toBe(0);
  });

  it('still hits the exact length on a clip too short to analyse', () => {
    // Under MIN_ANALYSIS_FRAMES there is no pitch to preserve — it is a click —
    // but the length contract still has to hold or every caller works around it.
    const out = fitToFrames(cap(sine(440, 64)), 200);
    expect(out.left.length).toBe(200);
    expect(allFinite(out.left)).toBe(true);
  });
});

describe('fitToFrames — stereo (REQ-5)', () => {
  /**
   * The regression that motivated REQ-5 covering the vocoder too.
   *
   * Integrating the phase per channel is the obvious shape, and it decorrelates
   * them: each channel drifts to its own phase and the two cancel when anything
   * sums them. **Every per-channel check passes while it happens** — the version
   * with this bug measured -0.2 dB on each channel alone and -5.7 dB in mono on a
   * rendered bar. Only a mono down-mix sees it, which is also how the app's own
   * `bench:metrics` measures a take.
   */
  it.each(MODES)('keeps the mono down-mix — the channels stay coherent (%s)', (mode) => {
    // Broadband and correlated-but-not-identical — the shape that actually drifts.
    // Pure tones do NOT reproduce this: both channels then carry the same phase in
    // every bin, so even a per-channel rotation happens to agree and the bug hides.
    // What decorrelates is content whose per-bin phase differs between the
    // channels, i.e. a shared source plus a little of its own.
    const n = 60_000;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x3fffffff - 1;
    };
    for (let i = 0; i < n; i++) {
      const shared = rnd() * 0.5 + Math.sin((2 * Math.PI * 196 * i) / SR) * 0.3;
      left[i] = shared + rnd() * 0.08;
      right[i] = shared * 0.9 + rnd() * 0.08;
    }
    const monoRms = (l: Float32Array, r: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < l.length; i++) { const m = (l[i]! + r[i]!) * 0.5; s += m * m; }
      return Math.sqrt(s / l.length);
    };

    const out = fitToFrames(cap(left, right), Math.round(n * 1.4), mode);
    const ratio = monoRms(out.left, out.right) / monoRms(left, right);
    // Generous either way: this is not a level assertion, it is a "did the two
    // channels stay in phase with each other" assertion. The bug read 0.52.
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  it.each(MODES)('both channels are assembled from one shared set of offsets (%s)', (mode) => {
    // The search runs once on the mono mixdown, so the two channels are spliced at
    // the same instants with the same window. That makes the whole operation linear
    // across channels: a right channel that is half the left must stay half the
    // left. A per-channel search, or a per-channel window, breaks this.
    const left = sine(311, 40_000);
    const right = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) right[i] = left[i]! * 0.5;

    const out = fitToFrames(cap(left, right), 55_000, mode);

    for (let i = 0; i < out.left.length; i += 97) {
      expect(out.right[i]!).toBeCloseTo(out.left[i]! * 0.5, 5);
    }
  });
});
