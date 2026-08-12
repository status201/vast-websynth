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
