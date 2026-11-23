import { describe, it, expect } from 'vitest';
import {
  MOTION_LANE_COUNT, MOTION_XY_LANE, isMotionLaneMuteId, motionLaneMuteId, motionTargetAllowed, motionTrackLane,
} from '../../src/state/motion-lanes';
import { MOTION_TRACK_COUNT } from '../../src/state/patterns';
import { ParamBus, registerDefaults } from '../../src/state/params';

/** motion-lane-mute.md: one table for the lane ↔ mute-id mapping and the target fence. */
describe('motion lanes', () => {
  it('counts the XY lane plus every track, and names each lane\'s mute', () => {
    expect(MOTION_LANE_COUNT).toBe(1 + MOTION_TRACK_COUNT);
    expect(motionLaneMuteId(MOTION_XY_LANE)).toBe('motion.xy.mute');
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      expect(motionLaneMuteId(motionTrackLane(t))).toBe(`motion.t${t}.mute`);
    }
    expect(() => motionLaneMuteId(MOTION_LANE_COUNT)).toThrow(RangeError);
  });

  // REQ-each-motion-lane-has-its-own-mute: default 0 is the no-op (ADR-006).
  it('registers every lane mute as a discrete param defaulting to on', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    for (let l = 0; l < MOTION_LANE_COUNT; l++) {
      const def = bus.def(motionLaneMuteId(l));
      expect(def, motionLaneMuteId(l)).toMatchObject({ default: 0, min: 0, max: 1, taper: 'discrete' });
    }
  });

  // REQ-a-lane-cannot-target-the-machine-or-itself
  it('refuses the machine switches and the lane\'s own mute, and allows the other lanes\' mutes', () => {
    for (let l = 0; l < MOTION_LANE_COUNT; l++) {
      expect(motionTargetAllowed(l, 'motion.on')).toBe(false);
      expect(motionTargetAllowed(l, 'motion.mute')).toBe(false);
      for (let other = 0; other < MOTION_LANE_COUNT; other++) {
        expect(motionTargetAllowed(l, motionLaneMuteId(other)), `${l} → ${other}`).toBe(other !== l);
      }
      expect(motionTargetAllowed(l, 'filter.cutoff')).toBe(true);
      expect(motionTargetAllowed(l, 'motion.t0.slide')).toBe(true);
    }
  });

  // REQ-a-lane-can-mute-another-lane: the sweep holds exactly these.
  it('knows the lane mutes from every other param', () => {
    for (let l = 0; l < MOTION_LANE_COUNT; l++) expect(isMotionLaneMuteId(motionLaneMuteId(l))).toBe(true);
    for (const id of ['motion.mute', 'motion.on', 'motion.t0.slide', 'drum.t0.mute', 'filter.cutoff']) {
      expect(isMotionLaneMuteId(id), id).toBe(false);
    }
  });
});
