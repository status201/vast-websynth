// Pure mixer logic for the Song tab's three lanes (sequencer / drums / sampler).
// Shared by the Engine (which applies audibility to the audio graph) and the
// Song panel (which dims silenced lanes), so the mute/solo rule lives in exactly
// one place. AudioContext-free, so it is unit-testable like the other pure
// transport units.

export type LaneId = 'seq' | 'drum' | 'sampler';

export const LANE_IDS: readonly LaneId[] = ['seq', 'drum', 'sampler'];

export type LaneFlags = Record<LaneId, boolean>;

/**
 * Which lanes are audible given their mute + solo state. Solo wins: if any lane
 * is soloed, only soloed lanes are audible (an explicit mute is ignored on a
 * soloed lane — standard DAW behaviour). With no solo active, a lane is audible
 * unless it is muted.
 */
export function audibleLanes(mute: LaneFlags, solo: LaneFlags): LaneFlags {
  const anySolo = solo.seq || solo.drum || solo.sampler;
  const audible = (l: LaneId): boolean => (anySolo ? solo[l] : !mute[l]);
  return { seq: audible('seq'), drum: audible('drum'), sampler: audible('sampler') };
}
