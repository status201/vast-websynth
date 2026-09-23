// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Phaser, stageCents } from '../../../src/audio/effects/phaser';
import { makeMockAudioContext, type MockAudioContext } from '../mock-audio-context';

/**
 * effects.md REQ-the-phaser-sweeps-in-cents (v13): the phaser sweeps each allpass
 * stage in **cents**, as v9 made the wah do.
 *
 * The v1 mapping added one `depth * 1500` linear-Hz swing to four stages centred
 * at 600..1119 Hz, so any stage centred under the swing was driven to the 0 Hz
 * floor for part of every cycle — 20.5% of it for the lowest stage at the synth
 * default of 0.5, up to 37% at full depth. Measured in Blink and Gecko, an
 * allpass held there is an exact pass-through: the stage dropped out of the
 * phaser. These pin the contract that makes that unreachable.
 */
describe('Phaser sweeps in cents (effects.md REQ-the-phaser-sweeps-in-cents)', () => {
  /** The stage centres the phaser builds, restated so the test fails if they drift. */
  const CENTRES = [0, 1, 2, 3].map((i) => 600 * Math.pow(2, i * 0.3));
  /** The mapping REQ-the-phaser-sweeps-in-cents specifies, restated likewise. */
  const cents = (d: number, fc: number) => 1200 * Math.log2(1 + (d * 1500) / fc);

  function build() {
    const ctx = makeMockAudioContext(48000);
    const phaser = new Phaser(ctx as unknown as AudioContext);
    // The four allpass stages are the only biquads the Phaser makes.
    const stages = ctx.createBiquadFilter.mock.results.map((r) => r.value) as ReturnType<
      MockAudioContext['createBiquadFilter']
    >[];
    // BypassWrapper builds six gains first; then one depth gain per stage.
    const gains = ctx.createGain.mock.results.map((r) => r.value);
    return { phaser, stages, depths: gains.slice(6, 10) };
  }

  /** The swing each stage's depth gain was last told to reach, in cents. */
  const swings = (depths: ReturnType<typeof build>['depths']) =>
    depths.map((g) => g.gain.setTargetAtTime.mock.calls.at(-1)![0] as number);

  it('sweeps each stage on detune, never on frequency', () => {
    const { stages, depths } = build();

    expect(stages).toHaveLength(4);
    stages.forEach((s, i) => {
      expect(s.type).toBe('allpass');
      expect(s.frequency.value).toBeCloseTo(CENTRES[i]!, 6);
      // frequency is written once at construction and never automated
      expect(s.frequency.setTargetAtTime).not.toHaveBeenCalled();
      expect(s.frequency.setValueAtTime).not.toHaveBeenCalled();
      // each stage's own depth gain lands on its detune
      expect(depths[i]!.connect).toHaveBeenCalledWith(s.detune);
      expect(depths[i]!.connect).not.toHaveBeenCalledWith(s.frequency);
    });
  });

  it('never drives a stage to 0 Hz, even at full depth (regression)', () => {
    const { phaser, depths } = build();

    // depth 1 is the widest the param allows (params.ts: fx.*phaser.depth max 1).
    // The linear mapping put every stage below 0 Hz here.
    phaser.setDepth(1);
    swings(depths).forEach((swing, i) => {
      expect(swing).toBeCloseTo(cents(1, CENTRES[i]!), 6);
      const bottom = CENTRES[i]! * Math.pow(2, -swing / 1200);
      expect(bottom).toBeGreaterThan(150);
    });
  });

  it('leaves the top of every stage where the linear mapping put it', () => {
    const { phaser, depths } = build();

    // 0.5 is the synth default, 0.7 the drum/sampler one, 0.195 Around's.
    for (const d of [0.195, 0.5, 0.7, 1]) {
      phaser.setDepth(d);
      swings(depths).forEach((swing, i) => {
        const top = CENTRES[i]! * Math.pow(2, swing / 1200);
        expect(top).toBeCloseTo(CENTRES[i]! + d * 1500, 6);
      });
    }
  });

  it('depth 0 leaves every stage unswept', () => {
    const { phaser, depths } = build();
    phaser.setDepth(0);
    expect(swings(depths)).toEqual([0, 0, 0, 0]);
    expect(stageCents(0, 600)).toBe(0);
  });
});
