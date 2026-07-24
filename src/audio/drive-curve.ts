import { clamp01 } from '../utils/math';

/**
 * Memoized WaveShaper drive curves.
 *
 * A `WaveShaperNode.curve` is a table, and building one is a fresh
 * `Float32Array` plus a transcendental per tap. Drive knobs are *dragged*, so
 * the naive "rebuild on every value" costs ~60-120 allocations a second (8 kB
 * each for the synth distortion's 2048 taps) plus the same number of `tanh`
 * sweeps — on the thread the transport schedules from.
 *
 * The fix is that a curve does not need the knob's full resolution: quantizing
 * the drive amount to `DRIVE_CURVE_STEPS` buckets is inaudible in a table that
 * is itself interpolated, and the surrounding pre/post gains keep ramping
 * continuously so the *sweep* stays smooth (ADR-010 — musical, stable, cheap).
 * After the first pass over a bucket the drag allocates nothing.
 *
 * Callers get identity-stable curves back, so `if (shaper.curve !== c)` is all
 * the "did it actually change?" guard they need — no bucket bookkeeping, the
 * same trick `Reverb` uses for its cached IR buffers.
 *
 * The curve *shape* stays with each caller: the synth distortion and the drum
 * per-track drive want different ones (only the drum's is anchored at a true
 * identity, so drive 0 is an exact no-op). This module owns the caching only.
 *
 * See specs/features/runtime-performance.md REQ-2 / specs/features/effects.md.
 */

/**
 * Distinct drive curves per cache. 64 buckets puts the steps ~1.6 % apart on the
 * knob — below the audible threshold for a saturation table, and small enough
 * that a full sweep's worth of curves is a few hundred kB at most.
 */
export const DRIVE_CURVE_STEPS = 64;

/**
 * Wrap a curve builder in a bucket cache. `build` is called at most once per
 * bucket and receives the *quantized* amount, so the returned table is exactly
 * the one every caller landing in that bucket shares.
 */
export function memoizeDriveCurve(
  build: (amount: number) => Float32Array<ArrayBuffer>,
): (amount: number) => Float32Array<ArrayBuffer> {
  const cache = new Map<number, Float32Array<ArrayBuffer>>();
  const last = DRIVE_CURVE_STEPS - 1;
  return (amount: number) => {
    const bucket = Math.round(clamp01(amount) * last);
    let curve = cache.get(bucket);
    if (!curve) {
      curve = build(bucket / last);
      cache.set(bucket, curve);
    }
    return curve;
  };
}
