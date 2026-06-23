import { describe, it, expect } from 'vitest';
import { audibleLanes, LANE_IDS, type LaneFlags } from '../../../src/audio/transport/lane-mix';

const none: LaneFlags = { seq: false, drum: false, sampler: false };
const f = (over: Partial<LaneFlags>): LaneFlags => ({ ...none, ...over });

describe('audibleLanes', () => {
  it('all lanes audible with no mute or solo', () => {
    expect(audibleLanes(none, none)).toEqual({ seq: true, drum: true, sampler: true });
  });

  it('a muted lane is silenced; the rest stay audible', () => {
    expect(audibleLanes(f({ drum: true }), none)).toEqual({ seq: true, drum: false, sampler: true });
  });

  it('solo silences every non-soloed lane', () => {
    expect(audibleLanes(none, f({ seq: true }))).toEqual({ seq: true, drum: false, sampler: false });
  });

  it('multiple solos keep all soloed lanes audible', () => {
    expect(audibleLanes(none, f({ seq: true, sampler: true }))).toEqual(
      { seq: true, drum: false, sampler: true },
    );
  });

  it('solo wins over a mute on the same lane (DAW behaviour)', () => {
    // drum is both muted and soloed → solo takes precedence, drum is audible.
    expect(audibleLanes(f({ drum: true }), f({ drum: true }))).toEqual(
      { seq: false, drum: true, sampler: false },
    );
  });

  it('exposes exactly the three lane ids', () => {
    expect([...LANE_IDS]).toEqual(['seq', 'drum', 'sampler']);
  });
});
