import { describe, it, expect } from 'vitest';
import {
  cloneCaptured,
  crop,
  reverse,
  normalize,
  gain,
  fadeIn,
  fadeOut,
  computePeaks,
  peakDb,
} from '../../src/audio/recorder/buffer-dsp';
import type { CapturedAudio } from '../../src/audio/recorder/node';

function cap(left: number[], right?: number[], sampleRate = 48000): CapturedAudio {
  return {
    left: new Float32Array(left),
    right: new Float32Array(right ?? left),
    sampleRate,
  };
}

describe('cloneCaptured', () => {
  it('deep-copies — mutating the clone never touches the source', () => {
    const a = cap([0.1, 0.2], [0.3, 0.4], 44100);
    const b = cloneCaptured(a);
    b.left[0] = 9;
    b.right[1] = 9;
    expect(a.left[0]).toBe(new Float32Array([0.1])[0]);
    expect(a.right[1]).toBe(new Float32Array([0.4])[0]);
    expect(b.sampleRate).toBe(44100);
  });
});

describe('crop', () => {
  it('keeps [start,end) and reports the right length', () => {
    const a = cap([0, 1, 2, 3, 4], [5, 6, 7, 8, 9]);
    const c = crop(a, 1, 4);
    expect(c.left.length).toBe(3);
    expect(Array.from(c.left)).toEqual([1, 2, 3]);
    expect(Array.from(c.right)).toEqual([6, 7, 8]);
  });

  it('clamps out-of-range indices', () => {
    const a = cap([0, 1, 2, 3]);
    expect(crop(a, -5, 99).left.length).toBe(4);
  });

  it('is a no-op clone when the range is empty/reversed', () => {
    const a = cap([0, 1, 2, 3]);
    const c = crop(a, 3, 1);
    expect(c.left.length).toBe(4);
    expect(c.left).not.toBe(a.left);
  });
});

describe('reverse', () => {
  it('mirrors both channels and is an involution', () => {
    const a = cap([1, 2, 3], [4, 5, 6]);
    const r = reverse(a);
    expect(Array.from(r.left)).toEqual([3, 2, 1]);
    expect(Array.from(r.right)).toEqual([6, 5, 4]);
    expect(Array.from(reverse(r).left)).toEqual([1, 2, 3]);
  });
});

describe('normalize', () => {
  it('scales so the loudest sample hits the target peak', () => {
    const a = cap([0.5, -0.25], [0.1, -0.1]);
    const n = normalize(a, 0.99);
    expect(n.left[0]!).toBeCloseTo(0.99, 5);
    expect(n.left[1]!).toBeCloseTo(-0.495, 5);
  });

  it('leaves silent input unchanged (no NaN / divide-by-zero)', () => {
    const a = cap([0, 0, 0]);
    const n = normalize(a);
    expect(Array.from(n.left)).toEqual([0, 0, 0]);
    expect(n.left.some((v) => Number.isNaN(v))).toBe(false);
  });
});

describe('gain', () => {
  it('multiplies every sample by the factor', () => {
    const a = cap([0.1, -0.2], [0.3, -0.4]);
    const g = gain(a, 2);
    expect(g.left[0]!).toBeCloseTo(0.2, 6);
    expect(g.right[1]!).toBeCloseTo(-0.8, 6);
  });
});

describe('fadeIn / fadeOut', () => {
  it('ramps the endpoints to ~0 without changing length', () => {
    const ones = new Array(48).fill(1);
    const a = cap(ones);
    const fi = fadeIn(a, 0.5); // ~24 samples at 48kHz
    expect(fi.left.length).toBe(48);
    expect(fi.left[0]!).toBeCloseTo(0, 6);
    expect(fi.left[47]!).toBeCloseTo(1, 6);

    const fo = fadeOut(a, 0.5);
    expect(fo.left[47]!).toBeCloseTo(0, 6);
    expect(fo.left[0]!).toBeCloseTo(1, 6);
  });

  it('clamps a fade longer than the buffer', () => {
    const a = cap([1, 1, 1, 1]);
    const fi = fadeIn(a, 100000);
    expect(fi.left.length).toBe(4);
    expect(fi.left[0]!).toBeCloseTo(0, 6);
  });
});

describe('peakDb', () => {
  it('reports -Infinity for silence, ~0 dB at full scale, ~-6 dB at half', () => {
    expect(peakDb(cap([0, 0, 0]))).toBe(-Infinity);
    expect(peakDb(cap([1, -1, 0.3]))).toBeCloseTo(0, 5);
    expect(peakDb(cap([0.5, -0.25]))).toBeCloseTo(-6.0206, 3);
  });
});

describe('computePeaks', () => {
  it('returns width*2 interleaved min,max with min <= max', () => {
    const a = cap([1, -1, 0.5, -0.5, 0.25, -0.25, 0, 0]);
    const p = computePeaks(a, 4);
    expect(p.length).toBe(8);
    for (let c = 0; c < 4; c++) {
      expect(p[c * 2]!).toBeLessThanOrEqual(p[c * 2 + 1]!);
    }
  });

  it('collapses a constant signal to min ≈ max ≈ value', () => {
    const a = cap(new Array(100).fill(0.5));
    const p = computePeaks(a, 10);
    for (let c = 0; c < 10; c++) {
      expect(p[c * 2]!).toBeCloseTo(0.5, 6);
      expect(p[c * 2 + 1]!).toBeCloseTo(0.5, 6);
    }
  });

  it('returns zeros for an empty buffer', () => {
    const p = computePeaks(cap([]), 5);
    expect(p.length).toBe(10);
    expect(Array.from(p)).toEqual(new Array(10).fill(0));
  });

  it('preserves over-unity peaks so the editor can flag clipping', () => {
    const a = cap([2, -2, 0.5, -0.5]);
    const p = computePeaks(a, 2);
    expect(p[0]!).toBeLessThan(-1); // first column min < -1
    expect(p[1]!).toBeGreaterThan(1); // first column max > 1
  });
});
