import { describe, it, expect } from 'vitest';
import { buildCuePass, autoLatency, takeStartFrame, readVoice } from '../../../src/audio/recorder/voice-take';
import type { CapturedAudio } from '../../../src/audio/recorder/node';

/** vocoder.md — the voice take's arithmetic, without a mic. */

const SR = 48000;

/** A ramp 1..n, so which frame landed where is readable from the values. */
function ramp(n: number): CapturedAudio {
  const left = Float32Array.from({ length: n }, (_, i) => i + 1);
  return { left, right: left.slice(), sampleRate: SR };
}

describe('buildCuePass (REQ-the-voice-take-follows-the-carrier)', () => {
  it('plays the carrier’s last bar, then all of it', () => {
    const { audio, cueFrames } = buildCuePass(ramp(30), 10);
    expect(cueFrames).toBe(10);
    expect(audio.left.length).toBe(40);
    expect([audio.left[0], audio.left[9], audio.left[10], audio.left[39]]).toEqual([21, 30, 1, 30]);
    expect(audio.right.length).toBe(40);
  });

  it('plays a carrier shorter than a bar twice', () => {
    const { audio, cueFrames } = buildCuePass(ramp(5), 10);
    expect(cueFrames).toBe(5);
    expect(Array.from(audio.left)).toEqual([1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
  });
});

describe('the crop window (REQ-the-voice-take-is-cropped-frame-exact)', () => {
  it('reads the take from where the carrier’s pass was heard', () => {
    expect(takeStartFrame({ takeAt: 0.5, latency: 0.02, sampleRate: SR, firstFrame: 1000 }))
      .toBe(Math.round(0.52 * SR) - 1000);
  });

  it('sums output and input latency, falling back to base latency, missing terms as 0, each clamped', () => {
    expect(autoLatency({ outputLatency: 0.03, baseLatency: 0.01, inputLatency: 0.005 })).toBeCloseTo(0.035);
    expect(autoLatency({ outputLatency: 0, baseLatency: 0.01 })).toBeCloseTo(0.01);
    expect(autoLatency({ outputLatency: Number.NaN, baseLatency: undefined, inputLatency: Infinity })).toBe(0);
    expect(autoLatency({ outputLatency: 3, inputLatency: 2 })).toBeCloseTo(1);
    expect(autoLatency({})).toBe(0);
  });
});

describe('readVoice (REQ-the-offset-slides-the-voice-without-re-recording)', () => {
  it('is exactly the asked length, silent before the take begins', () => {
    const v = readVoice(ramp(10), -3, 6);
    expect(Array.from(v.left)).toEqual([0, 0, 0, 1, 2, 3]);
    expect(v.right.length).toBe(6);
  });

  it('pads past the take’s end, and reads inside it unchanged', () => {
    expect(Array.from(readVoice(ramp(10), 7, 5).left)).toEqual([8, 9, 10, 0, 0]);
    expect(Array.from(readVoice(ramp(10), 2, 3).left)).toEqual([3, 4, 5]);
    expect(Array.from(readVoice(ramp(10), 50, 2).left)).toEqual([0, 0]);
  });
});
