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
  sliceEqual,
  sliceRanges,
  detectOnsets,
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

/**
 * sample-chop.md REQ-3/REQ-4.
 *
 * A chop is right only if the slices start ON the hits, so these tests are built
 * from material whose onsets are known by construction — a detector tested
 * against real audio can only be eyeballed, and an eyeballed detector is the one
 * that quietly regresses.
 */
describe('chopping', () => {
  const SR = 44100;

  /** Silence with a decaying click at each of `atSec`. */
  function clickTrain(atSec: number[], durSec = 2, decay = 40): CapturedAudio {
    const n = Math.round(durSec * SR);
    const left = new Float32Array(n);
    for (const t of atSec) {
      const start = Math.round(t * SR);
      for (let i = 0; i < SR * 0.25 && start + i < n; i++) {
        left[start + i]! += Math.sin((2 * Math.PI * 300 * i) / SR) * Math.exp((-i / SR) * decay);
      }
    }
    return { left, right: left.slice(), sampleRate: SR };
  }

  describe('sliceEqual', () => {
    it('returns the interior boundaries only — n slices have n-1 cuts', () => {
      const a = clickTrain([0], 1);
      expect(sliceEqual(a, 4)).toEqual([11025, 22050, 33075]);
      expect(sliceEqual(a, 1)).toEqual([]);
      expect(sliceEqual(a, 0)).toEqual([]);
    });

    it('divides the selection, not the file (REQ-2)', () => {
      const a = clickTrain([0], 2); // 88200 samples
      // The middle half: 22050..66150.
      expect(sliceEqual(a, 2, 22050, 66150)).toEqual([44100]);
    });

    it('refuses to cut a region into more slices than it has samples', () => {
      const a = clickTrain([0], 1);
      expect(sliceEqual(a, 8, 0, 4)).toEqual([]);
    });
  });

  describe('sliceRanges', () => {
    it('turns boundaries into consecutive half-open pairs', () => {
      expect(sliceRanges(0, 100, [25, 50, 75])).toEqual([[0, 25], [25, 50], [50, 75], [75, 100]]);
    });

    it('ignores boundaries outside the region, so a stale marker cannot widen it', () => {
      expect(sliceRanges(10, 20, [5, 15, 99])).toEqual([[10, 15], [15, 20]]);
    });

    it('is one range when there are no boundaries', () => {
      expect(sliceRanges(0, 10, [])).toEqual([[0, 10]]);
    });
  });

  describe('detectOnsets', () => {
    it('finds the hits and not the gaps between them', () => {
      const a = clickTrain([0, 0.5, 1.0, 1.5]);
      const bounds = detectOnsets(a, { maxSlices: 4 });
      expect(bounds).toHaveLength(3);
      const expected = [0.5, 1.0, 1.5].map((t) => t * SR);
      bounds.forEach((b, i) => {
        // The error must be SIGNED, not just small: a boundary a few ms early
        // costs a slice some lead-in silence, while one a few ms late saws the
        // front off its own transient. Only one of those is a chop.
        expect(b).toBeLessThanOrEqual(expected[i]!);
        expect(expected[i]! - b).toBeLessThan(SR * 0.025);
      });
    });

    it('reports the first hit as the region start, not as a boundary', () => {
      // A boundary at 0 would make an empty first slice.
      const a = clickTrain([0, 0.5]);
      expect(detectOnsets(a, { maxSlices: 4 }).every((b) => b > 0)).toBe(true);
    });

    it('does not re-trigger on a long decay (REQ-4, edge)', () => {
      const a = clickTrain([0.2], 2, 4); // ONE hit, ringing for ~0.25 s
      const bounds = detectOnsets(a, { maxSlices: 8 });
      // Exactly one: the hit itself. Without the refractory period the decay
      // re-triggers for as long as it rings and a single snare becomes a dozen
      // slices — which is the failure this test exists for, not the boundary
      // count. (The hit is interior here because silence precedes it.)
      expect(bounds).toHaveLength(1);
      expect(bounds[0]!).toBeLessThanOrEqual(0.2 * SR);
      expect(0.2 * SR - bounds[0]!).toBeLessThan(SR * 0.025);
    });

    it('keeps the strongest hits when there are more than slots, in time order', () => {
      const a = clickTrain([0, 0.3, 0.6, 0.9, 1.2, 1.5]);
      const bounds = detectOnsets(a, { maxSlices: 3 });
      expect(bounds.length).toBeLessThanOrEqual(2);
      expect([...bounds].sort((x, y) => x - y)).toEqual(bounds);
    });

    it('returns nothing for silence rather than cutting it up', () => {
      const silence: CapturedAudio = {
        left: new Float32Array(SR), right: new Float32Array(SR), sampleRate: SR,
      };
      expect(detectOnsets(silence, { maxSlices: 8 })).toEqual([]);
    });

    it('honours the selection bounds (REQ-2)', () => {
      const a = clickTrain([0, 0.5, 1.0, 1.5]);
      const bounds = detectOnsets(a, { from: 0.4 * SR, to: 1.1 * SR, maxSlices: 8 });
      expect(bounds.every((b) => b > 0.4 * SR && b < 1.1 * SR)).toBe(true);
    });
  });

  it('round-trips through crop: the slices reassemble the region', () => {
    const a = clickTrain([0, 0.5, 1.0, 1.5]);
    const ranges = sliceRanges(0, a.left.length, sliceEqual(a, 4));
    const total = ranges.reduce((n, [s, e]) => n + crop(a, s, e).left.length, 0);
    expect(total).toBe(a.left.length);
  });
});
