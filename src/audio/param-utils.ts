export const RAMP_FAST = 0.005;
export const RAMP_MEDIUM = 0.01;
/**
 * The insert effects' smoothing constant. Slower than `RAMP_MEDIUM` because an
 * effect's controls (delay time, feedback, drive, LFO rate, filter Q) are swept
 * by hand and audibly zipper at a shorter constant.
 */
export const RAMP_SMOOTH = 0.02;
export const RAMP_SLOW = 0.05;

export function rampTo(
  param: AudioParam,
  value: number,
  ctx: AudioContext,
  timeConstant = RAMP_FAST,
): void {
  const t = ctx.currentTime;
  param.setTargetAtTime(value, t, timeConstant);
}

export function rampCancelAndSet(
  param: AudioParam,
  value: number,
  ctx: AudioContext,
  timeConstant = RAMP_FAST,
): void {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setTargetAtTime(value, t, timeConstant);
}

/**
 * A 0..1 "tone" knob mapped to a lowpass cutoff in Hz, exponentially across
 * 300 Hz…20 kHz. **1 is open**, i.e. a no-op (ADR-006) — which is why both the drum
 * machine's per-track tone and the sampler's per-slot tone default to it.
 *
 * Shared rather than written twice so "tone" cannot come to mean two different
 * curves on two machines — the same reason `fx-chain.ts` instantiates one delay
 * factory per chain instead of copying the delay.
 */
export function toneCutoff(tone: number): number {
  const min = 300, max = 20000;
  const t = tone < 0 ? 0 : tone > 1 ? 1 : tone;
  return min * Math.pow(max / min, t);
}
