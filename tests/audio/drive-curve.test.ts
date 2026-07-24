import { describe, it, expect, vi } from 'vitest';
import { memoizeDriveCurve, DRIVE_CURVE_STEPS } from '../../src/audio/drive-curve';

/**
 * Bucketed WaveShaper curve caching (runtime-performance.md REQ-2). Drive knobs
 * are dragged, and a fresh table per bus tick is ~120 allocations a second plus
 * the same number of `tanh` sweeps, on the thread the transport schedules from.
 */
describe('memoizeDriveCurve', () => {
  const mk = () => {
    const build = vi.fn((amount: number) => Float32Array.from([amount]));
    return { build, curve: memoizeDriveCurve(build) };
  };

  it('builds once per bucket and returns the identical array after', () => {
    const { build, curve } = mk();
    const a = curve(0.5);
    const b = curve(0.5);
    expect(b).toBe(a);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('collapses a drag into at most DRIVE_CURVE_STEPS builds', () => {
    const { build, curve } = mk();
    // 500 pointermove-shaped updates across the whole range, three times over.
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i <= 500; i++) curve(i / 500);
    }
    expect(build).toHaveBeenCalledTimes(DRIVE_CURVE_STEPS);
  });

  it('passes the quantized amount to the builder, not the raw one', () => {
    const { build, curve } = mk();
    curve(0.5);
    // The bucket centre, so every amount landing here shares one table.
    const quantized = Math.round(0.5 * (DRIVE_CURVE_STEPS - 1)) / (DRIVE_CURVE_STEPS - 1);
    expect(build).toHaveBeenCalledWith(quantized);
  });

  it('keeps the endpoints exact — 0 stays a true no-op', () => {
    const { curve } = mk();
    expect(curve(0)[0]).toBe(0);
    expect(curve(1)[0]).toBe(1);
  });

  it('clamps out-of-range amounts onto the end buckets (edge)', () => {
    const { build, curve } = mk();
    expect(curve(-3)).toBe(curve(0));
    expect(curve(7)).toBe(curve(1));
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('nearby amounts share a bucket, distant ones do not', () => {
    const { curve } = mk();
    expect(curve(0.5)).toBe(curve(0.505));
    expect(curve(0.5)).not.toBe(curve(0.6));
  });

  it('each cache is independent, so different curve shapes never mix', () => {
    const a = memoizeDriveCurve(() => Float32Array.from([1]));
    const b = memoizeDriveCurve(() => Float32Array.from([2]));
    expect(a(0.5)[0]).toBe(1);
    expect(b(0.5)[0]).toBe(2);
  });
});
