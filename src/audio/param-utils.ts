export const RAMP_FAST = 0.005;
export const RAMP_MEDIUM = 0.01;
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
