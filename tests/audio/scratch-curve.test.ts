import { describe, it, expect } from 'vitest';
import {
  normalizeCurve,
  scratchPlan,
  rateAt,
  positionAt,
  gainAt,
  curveExtent,
  autoCue,
  warpPeaks,
  scratchPreset,
  randomScratch,
  SCRATCH_PRESETS,
  DEFAULT_SCRATCH_STEPS,
  type ScratchCurve,
  type ScratchPoint,
} from '../../src/audio/recorder/scratch-curve';
import {
  MAX_SCRATCH_POINTS,
  MAX_SCRATCH_RATE,
  MAX_SCRATCH_STEPS,
} from '../../src/state/limits';

type Row = [t: number, v: number, cut?: boolean, hold?: boolean];

function curve(rows: readonly Row[], steps = 16, cue = 0): ScratchCurve {
  return {
    steps,
    cue,
    points: rows.map(([t, v, cut = false, hold = false]) => ({ t, v, cut, hold })),
  };
}

describe('normalizeCurve', () => {
  it('orders, clamps and bounds a hostile curve', () => {
    const c = normalizeCurve(curve([
      [0.9, 1], [0.2, 99], [0.5, -99], [0, 1],
    ], 9999));
    expect(c.steps).toBe(MAX_SCRATCH_STEPS);
    expect(c.points.map((p) => p.t)).toEqual([0, 0.2, 0.5, 0.9]);
    expect(c.points[1]!.v).toBe(MAX_SCRATCH_RATE);
    expect(c.points[2]!.v).toBe(-MAX_SCRATCH_RATE);
  });

  it('drops non-finite points instead of propagating them', () => {
    const c = normalizeCurve(curve([
      [0, 1], [NaN, 1], [0.5, Infinity], [0.7, 1],
    ]));
    expect(c.points.map((p) => p.t)).toEqual([0, 0.7]);
    for (const p of c.points) expect(Number.isFinite(p.v)).toBe(true);
  });

  it('falls back rather than passing a non-finite length through', () => {
    expect(normalizeCurve(curve([[0, 1]], NaN)).steps).toBe(DEFAULT_SCRATCH_STEPS);
    expect(normalizeCurve({ ...curve([[0, 1]]), cue: NaN }).cue).toBe(0);
  });

  it('gives a curve that does not start at 0 an opening twin', () => {
    const c = normalizeCurve(curve([[0.4, 2]]));
    expect(c.points.map((p) => [p.t, p.v])).toEqual([[0, 2], [0.4, 2]]);
  });

  it('caps the point count', () => {
    const many = Array.from({ length: MAX_SCRATCH_POINTS * 3 },
      (_, i): Row => [i / (MAX_SCRATCH_POINTS * 3), 1]);
    expect(normalizeCurve(curve(many)).points.length).toBe(MAX_SCRATCH_POINTS);
  });

  it('is idempotent', () => {
    const once = normalizeCurve(curve([[0.5, 2], [0, 1], [0.9, -3]]));
    expect(normalizeCurve(once)).toEqual(once);
  });

  it('survives a curve with no points at all', () => {
    const c = normalizeCurve(curve([]));
    expect(c.points).toEqual([]);
    expect(scratchPlan(c).n).toBe(0);
  });
});

describe('the position map', () => {
  it('holds a single point across the whole scratch', () => {
    const c = curve([[0, 1]]);
    expect(rateAt(c, 0)).toBe(1);
    expect(rateAt(c, 0.5)).toBe(1);
    expect(positionAt(c, 0.5)).toBeCloseTo(0.5, 12);
    expect(positionAt(c, 1)).toBeCloseTo(1, 12);
  });

  it('integrates a ramp in closed form', () => {
    // 0 -> 2 over the whole scratch: the mean rate is 1, so the needle ends at 1,
    // and at the halfway point it has covered a quarter (the triangle's area).
    const c = curve([[0, 0], [1, 2]]);
    expect(positionAt(c, 0.5)).toBeCloseTo(0.25, 12);
    expect(positionAt(c, 1)).toBeCloseTo(1, 12);
    expect(rateAt(c, 0.5)).toBeCloseTo(1, 12);
  });

  it('integrates a hold as a rectangle and jumps at the boundary', () => {
    const c = curve([[0, 2, false, true], [0.5, -1, false, true]]);
    expect(positionAt(c, 0.5)).toBeCloseTo(1, 12);
    expect(positionAt(c, 1)).toBeCloseTo(0.5, 12);
    expect(rateAt(c, 0.49)).toBeCloseTo(2, 12);
    expect(rateAt(c, 0.51)).toBeCloseTo(-1, 12);
  });

  it('does not drift across many segments', () => {
    // 64 alternating unit strokes: every pair cancels, so the exact answer is 0.
    const rows: Row[] = [];
    for (let i = 0; i < 64; i++) rows.push([i / 64, i % 2 === 0 ? 1 : -1, false, true]);
    const c = curve(rows);
    expect(positionAt(c, 1)).toBeCloseTo(0, 12);
  });

  it('divides by no zero when two points share an instant', () => {
    const c = curve([[0, 1], [0.5, 1], [0.5, -1], [1, -1]]);
    expect(Number.isFinite(positionAt(c, 0.5))).toBe(true);
    expect(Number.isFinite(positionAt(c, 1))).toBe(true);
  });

  it('reports the fader as a target gain', () => {
    const c = curve([[0, 1, false, true], [0.5, 1, true, true]]);
    expect(gainAt(c, 0.25)).toBe(1);
    expect(gainAt(c, 0.75)).toBe(0);
  });
});

describe('curveExtent', () => {
  it('finds the turning point inside a ramp, not just the endpoints', () => {
    // +1 ramping to -1 across the scratch. Both ends sit at 0 position; the
    // needle actually reaches +0.25 halfway, and only the interior root sees it.
    const c = curve([[0, 1], [1, -1]]);
    const { min, max } = curveExtent(c);
    expect(max).toBeCloseTo(0.25, 12);
    expect(min).toBeCloseTo(0, 12);
  });

  it('reports how far back a backwards opening reaches', () => {
    const { min } = curveExtent(curve([[0, -1, false, true], [0.5, 1, false, true]]));
    expect(min).toBeCloseTo(-0.5, 12);
  });
});

describe('autoCue', () => {
  it('drops the needle far enough in to cover a backwards opening', () => {
    const c = curve([[0, -1, false, true], [0.5, 1, false, true]]);
    // The gesture reaches 0.5 output-units back, which at these lengths is half
    // the source — so the cue has to sit at least halfway in.
    expect(autoCue(c, 1000, 1000)).toBeCloseTo(0.5, 6);
  });

  it('leaves a forward-only gesture at the start', () => {
    expect(autoCue(curve([[0, 1]]), 10_000, 1000)).toBe(0);
  });

  it('keeps the start when the gesture is longer than the sample', () => {
    const cue = autoCue(curve([[0, -1, false, true], [0.5, 1, false, true]]), 100, 10_000);
    expect(cue).toBeGreaterThanOrEqual(0);
    expect(cue).toBeLessThanOrEqual(1);
  });

  it('refuses degenerate lengths without producing NaN', () => {
    expect(autoCue(curve([[0, 1]]), 0, 1000)).toBe(0);
    expect(autoCue(curve([[0, 1]]), 1000, 0)).toBe(0);
  });
});

describe('warpPeaks', () => {
  /** A peak array that is silent except for one loud column at `at`. */
  function spike(width: number, at: number): Float32Array {
    const p = new Float32Array(width * 2);
    p[at * 2] = -1;
    p[at * 2 + 1] = 1;
    return p;
  }

  it('puts a transient where the needle actually reaches it', () => {
    // Unity rate, cue 0, source and output the same length: column j of the
    // output reads column j of the source, so the spike stays put.
    const peaks = spike(100, 50);
    const out = warpPeaks(peaks, curve([[0, 1]]), 1000, 1000, 100);
    expect(out[50 * 2 + 1]).toBe(1);
    expect(out[10 * 2 + 1]).toBe(0);
  });

  it('moves the transient when the needle runs at double speed', () => {
    // At rate 2 the needle reaches the halfway spike a quarter of the way in.
    const out = warpPeaks(spike(100, 50), curve([[0, 2]]), 1000, 1000, 100);
    expect(out[25 * 2 + 1]).toBe(1);
    expect(out[50 * 2 + 1]).toBe(0);
  });

  it('draws a cut segment as silence, like the reader plays it', () => {
    const flat = new Float32Array(200);
    flat.fill(1);
    const out = warpPeaks(flat, curve([[0, 1, true, true]]), 1000, 1000, 100);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('draws nothing where the needle is off the record', () => {
    const flat = new Float32Array(200);
    flat.fill(1);
    // Cued at the very end and running forward: everything is past the record.
    const out = warpPeaks(flat, curve([[0, 1]], 16, 1), 1000, 1000, 100);
    expect(out[90 * 2 + 1]).toBe(0);
  });

  it('refuses degenerate arguments without allocating a wrong-sized result', () => {
    expect(warpPeaks(new Float32Array(0), curve([[0, 1]]), 1000, 1000, 8).length).toBe(16);
    expect(warpPeaks(new Float32Array(8), curve([[0, 1]]), 0, 1000, 8).length).toBe(16);
    expect(warpPeaks(new Float32Array(8), curve([[0, 1]]), 1000, 1000, -5).length).toBe(0);
  });
});

describe('presets and the dice', () => {
  const inModel = (pts: readonly ScratchPoint[]): void => {
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.length).toBeLessThanOrEqual(MAX_SCRATCH_POINTS);
    expect(pts[0]!.t).toBe(0);
    let last = -1;
    for (const p of pts) {
      expect(p.t).toBeGreaterThanOrEqual(last);
      expect(p.t).toBeLessThanOrEqual(1);
      expect(Math.abs(p.v)).toBeLessThanOrEqual(MAX_SCRATCH_RATE);
      last = p.t;
    }
  };

  it('every named preset is inside the model at every length', () => {
    for (const name of SCRATCH_PRESETS) {
      for (const steps of [1, 4, 16, MAX_SCRATCH_STEPS]) {
        const c = scratchPreset(name, steps);
        expect(c.steps).toBe(steps);
        inModel(c.points);
      }
    }
  });

  it('the default preset ends further forward than it began', () => {
    // "Short, short, long" — the pairs cancel and the long stroke carries it out.
    expect(positionAt(scratchPreset('Baby', 16), 1)).toBeGreaterThan(0.2);
  });

  it('the default preset never runs off the front', () => {
    expect(curveExtent(scratchPreset('Baby', 16)).min).toBeCloseTo(0, 6);
  });

  it('the transformer cuts without ever changing speed', () => {
    const c = scratchPreset('Transformer', 16);
    for (const p of c.points) expect(p.v).toBe(1);
    expect(c.points.some((p) => p.cut)).toBe(true);
  });

  it('a hundred rolls all stay inside the model', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 100; i++) {
      const c = randomScratch(1 + (i % MAX_SCRATCH_STEPS), rnd);
      inModel(c.points);
      expect(Number.isFinite(positionAt(c, 1))).toBe(true);
    }
  });

  it('rolls something different from one call to the next', () => {
    const shapes = new Set(
      Array.from({ length: 20 }, () => JSON.stringify(randomScratch(16).points)),
    );
    expect(shapes.size).toBeGreaterThan(1);
  });
});
