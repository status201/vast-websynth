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
  // The IR bank is generated lazily and cached per (sampleRate, duration) —
  // see reverb.test.ts — so sweep every size to observe the whole bank, and give
  // each case its own sample rate so the shared cache cannot answer for it.
  let rate = 48000;
  function irSeconds(maxIrS?: number): number[] {
    const ctx = makeMockAudioContext(rate++);
    const reverb = new Reverb(
      ctx as unknown as AudioContext,
      maxIrS === undefined ? undefined : { maxIrS },
    );
    for (let i = 0; i < 5; i++) reverb.setSize(i / 4);
    return (ctx.createBuffer as unknown as Spy).mock.calls
      // Length is a whole number of frames, so recover the duration to the ms.
      .map((c) => Math.round(((c[1] as number) / (c[2] as number)) * 1000) / 1000)
      .sort((a, b) => a - b);
  }

  it('defaults to the full bank [0.4, 0.8, 1.5, 2.5, 4.0]', () => {
    expect(irSeconds()).toEqual([0.4, 0.8, 1.5, 2.5, 4.0]);
  });

  it('caps durations, not the bank size, so setSize index mapping is unchanged', () => {
    // Three sizes collapse onto the 1.5 s cap, so only three IRs are ever built —
    // but `size` still spans five bank positions, which is what REQ-11 promises.
    expect(irSeconds(1.5)).toEqual([0.4, 0.8, 1.5]);
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
