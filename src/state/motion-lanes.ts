import { MOTION_TRACK_COUNT } from './patterns';

/**
 * Motion lane identity (motion-lane-mute.md): lane 0 is the XY
 * lane, lane `1 + t` is track `t`. The count and the lane ↔ mute-id mapping
 * live here once, so the params, the engine binding, the panel and the XY
 * resolver all derive from the same table (ADR-022's rule, one level in).
 */

/** The XY lane's index. */
export const MOTION_XY_LANE = 0;

/** Every lane the machine runs: the XY lane plus the single-param tracks. */
export const MOTION_LANE_COUNT = 1 + MOTION_TRACK_COUNT;

/** Track `t`'s lane index. */
export const motionTrackLane = (t: number): number => 1 + t;

/**
 * One id per lane, interned once: the machine compares against these on the
 * write path, so they must be the same strings every time (REQ-a-lane-cannot-target-the-machine-or-itself).
 * `motion.mute` is the machine-wide mute, hence `motion.xy.mute` for lane 0.
 */
const MUTE_IDS: readonly string[] = Array.from({ length: MOTION_LANE_COUNT }, (_, lane) =>
  lane === MOTION_XY_LANE ? 'motion.xy.mute' : `motion.t${lane - 1}.mute`);

const MUTE_ID_SET: ReadonlySet<string> = new Set(MUTE_IDS);

/** Whether `id` is one of the lane mutes — a switch, not a sound
 *  (motion-lane-mute.md REQ-a-lane-can-mute-another-lane). */
export function isMotionLaneMuteId(id: string): boolean {
  return MUTE_ID_SET.has(id);
}

/** The param that mutes `lane` (motion-lane-mute.md REQ-each-motion-lane-has-its-own-mute). */
export function motionLaneMuteId(lane: number): string {
  const id = MUTE_IDS[lane];
  if (id === undefined) throw new RangeError(`no motion lane ${lane}`);
  return id;
}

/**
 * Whether `lane` may drive `id` (REQ-a-lane-cannot-target-the-machine-or-itself).
 * The machine switch, the machine-wide mute and the lane's own mute are
 * refused: writing any of them triggers a restore that undoes the write, which
 * the next frame repeats — an oscillation at frame rate. Every other lane's
 * mute stays a target; that is REQ-a-lane-can-mute-another-lane.
 */
export function motionTargetAllowed(lane: number, id: string): boolean {
  return id !== 'motion.on' && id !== 'motion.mute' && id !== MUTE_IDS[lane];
}
