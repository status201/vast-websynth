import { describe, it, expect, vi } from 'vitest';
import { LaneMixer } from '../../src/audio/lane-mixer';
import { makeMockAudioContext } from './mock-audio-context';

function build() {
  const ctx = makeMockAudioContext();
  const seq = { setMuted: vi.fn() };
  const drums = { setLaneAudible: vi.fn() };
  const sampler = { setLaneAudible: vi.fn() };
  const drumBus = ctx.createGain() as unknown as GainNode;
  const samplerBus = ctx.createGain() as unknown as GainNode;
  const mix = new LaneMixer(ctx as unknown as AudioContext, seq, drumBus, samplerBus, drums, sampler);
  return { ctx, seq, drums, sampler, drumBus, samplerBus, mix };
}

const gainOf = (bus: GainNode) => bus.gain as unknown as { setTargetAtTime: ReturnType<typeof vi.fn> };

describe('LaneMixer', () => {
  // song-mode.md REQ-a-lane-mute-silences-the-pattern-not-the-hands: a mute closes
  // the lane's gate (pattern hits only); the bus keeps the volume, so an audition
  // still sounds at the lane's level.
  it('muting drums closes the drum gate; both buses keep their volume', () => {
    const { drums, sampler, drumBus, samplerBus, mix } = build();
    mix.setMute('drum', true);
    expect(drums.setLaneAudible).toHaveBeenLastCalledWith(false);
    expect(sampler.setLaneAudible).toHaveBeenLastCalledWith(true);
    expect(gainOf(drumBus).setTargetAtTime).toHaveBeenLastCalledWith(0.85, 0, expect.any(Number));
    expect(gainOf(samplerBus).setTargetAtTime).toHaveBeenLastCalledWith(0.85, 0, expect.any(Number));
  });

  it('a solo elsewhere closes the sampler gate but never cuts its bus (regression)', () => {
    const { sampler, samplerBus, mix } = build();
    mix.setSolo('seq', true);
    expect(sampler.setLaneAudible).toHaveBeenLastCalledWith(false);
    expect(gainOf(samplerBus).setTargetAtTime).toHaveBeenLastCalledWith(0.85, 0, expect.any(Number));
    mix.setSolo('seq', false);
    expect(sampler.setLaneAudible).toHaveBeenLastCalledWith(true);
  });

  it('mutes the sequencer by suppressing triggering (not its bus)', () => {
    const { seq, mix } = build();
    mix.setMute('seq', true);
    expect(seq.setMuted).toHaveBeenLastCalledWith(true);
  });

  it('solo wins over mute on the same lane (drum soloed + muted → audible)', () => {
    const { drums, mix } = build();
    mix.setMute('drum', true);
    mix.setSolo('drum', true);
    expect(drums.setLaneAudible).toHaveBeenLastCalledWith(true);
  });

  it('a solo on another lane closes the non-soloed drum gate', () => {
    const { drums, mix } = build();
    mix.setSolo('seq', true);
    expect(drums.setLaneAudible).toHaveBeenLastCalledWith(false);
  });

  it('the drum volume knob drives the audible bus gain', () => {
    const { drumBus, mix } = build();
    mix.setDrumVol(0.5);
    expect(gainOf(drumBus).setTargetAtTime).toHaveBeenLastCalledWith(0.5, 0, expect.any(Number));
  });

  /**
   * drum-machine.md REQ-every-sounded-hit-is-reported v8. Cutting the bus gain is not enough on its own:
   * the machine keeps playing so un-mute is instant, so anything keyed off its
   * hits kept firing against drums nobody could hear — a ducker pumping to a
   * silent kick. The rule is reported ⇔ audible, which is why this reads the
   * same `audibleLanes` verdict the bus gain does.
   */
  describe('hit reporting follows audibility (REQ-every-sounded-hit-is-reported v8, regression)', () => {
    it('silences the reports when the drum lane is muted, and restores them', () => {
      const { drums, mix } = build();
      mix.setMute('drum', true);
      expect(drums.setLaneAudible).toHaveBeenLastCalledWith(false);
      mix.setMute('drum', false);
      expect(drums.setLaneAudible).toHaveBeenLastCalledWith(true);
    });

    it('silences them when another lane is soloed', () => {
      const { drums, mix } = build();
      mix.setSolo('seq', true);
      expect(drums.setLaneAudible).toHaveBeenLastCalledWith(false);
    });

    it('keeps them when the drum lane itself is soloed, even if also muted', () => {
      const { drums, mix } = build();
      mix.setMute('drum', true);
      mix.setSolo('drum', true);
      expect(drums.setLaneAudible).toHaveBeenLastCalledWith(true);
    });

    it('leaves them alone for a volume change', () => {
      const { drums, mix } = build();
      mix.setDrumVol(0.5);
      expect(drums.setLaneAudible).toHaveBeenLastCalledWith(true);
    });
  });
});
