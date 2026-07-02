import { describe, it, expect, vi } from 'vitest';
import { Reverb } from '../../../src/audio/effects/reverb';
import { Distortion } from '../../../src/audio/effects/distortion';
import { makeMockAudioContext } from '../mock-audio-context';

/**
 * Weak-tier FX-cost reductions (performance-mode.md REQ-11): the reverb IR
 * bank is capped by duration (never by bank size) and the distortion's
 * WaveShaper oversampling can be disabled — both at construction.
 */
describe('Reverb IR duration cap', () => {
  type Spy = ReturnType<typeof vi.fn>;
  function irSeconds(maxIrS?: number): number[] {
    const ctx = makeMockAudioContext(48000);
    new Reverb(ctx as unknown as AudioContext, maxIrS === undefined ? undefined : { maxIrS });
    return (ctx.createBuffer as unknown as Spy).mock.calls.map(
      (c) => (c[1] as number) / (c[2] as number),
    );
  }

  it('defaults to the full bank [0.4, 0.8, 1.5, 2.5, 4.0]', () => {
    expect(irSeconds()).toEqual([0.4, 0.8, 1.5, 2.5, 4.0]);
  });

  it('caps durations, not the bank size, so setSize index mapping is unchanged', () => {
    expect(irSeconds(1.5)).toEqual([0.4, 0.8, 1.5, 1.5, 1.5]);
  });
});

describe('Distortion oversampling', () => {
  function shaperOversample(opts?: { oversample?: boolean }): string {
    const ctx = makeMockAudioContext();
    new Distortion(ctx as unknown as AudioContext, opts);
    const shaper = (ctx.createWaveShaper as unknown as ReturnType<typeof vi.fn>).mock.results[0]!
      .value as { oversample: string };
    return shaper.oversample;
  }

  it('defaults to 4x', () => {
    expect(shaperOversample()).toBe('4x');
  });

  it('runs at none when the tier disallows oversampling', () => {
    expect(shaperOversample({ oversample: false })).toBe('none');
  });
});
