import { describe, it, expect, vi } from 'vitest';
import { clipFades, fadeOutAt, SAMPLER_ATTACK, CHOKE_FADE } from '../../src/audio/clip-fades';
import { ClipPreview } from '../../src/audio/recorder/clip-preview';

/**
 * The editor preview's edges are the sampler's (sample-recorder.md
 * REQ-the-preview-fades-like-the-slot). Started and stopped raw, a selection cut
 * mid-waveform clicked at both ends in the preview while the same selection
 * played clean from its slot.
 */
function param() {
  return {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}
const asParam = (p: ReturnType<typeof param>) => p as unknown as AudioParam;

describe('clipFades (REQ-the-preview-fades-like-the-slot)', () => {
  it('ramps in over SAMPLER_ATTACK and out to 0 exactly as the clip ends', () => {
    const p = param();
    clipFades(asParam(p), 2, 1);
    expect(p.setValueAtTime.mock.calls).toEqual([[0, 2], [1, 3 - CHOKE_FADE]]);
    expect(p.linearRampToValueAtTime.mock.calls).toEqual([[1, 2 + SAMPLER_ATTACK], [0, 3]]);
  });

  it('reports the level the shape reaches, so a Stop fades from where it is', () => {
    const p = param();
    const levelAt = clipFades(asParam(p), 0, 1);
    expect(levelAt(-1)).toBe(0);
    expect(levelAt(SAMPLER_ATTACK / 2)).toBeCloseTo(0.5, 12);
    expect(levelAt(0.5)).toBe(1);
    expect(levelAt(1 - CHOKE_FADE / 2)).toBeCloseTo(0.5, 12);
    expect(levelAt(1)).toBe(0);
  });

  it('keeps a clip shorter than both fades well formed (edge)', () => {
    const p = param();
    const levelAt = clipFades(asParam(p), 0, 0.002);
    for (let t = 0; t <= 0.002; t += 0.0001) {
      const v = levelAt(t);
      expect(Number.isFinite(v) && v >= 0 && v <= 1).toBe(true);
    }
  });
});

describe('fadeOutAt', () => {
  it('fades from the given level to 0 over CHOKE_FADE, anchored, and says when', () => {
    const p = param();
    const silentAt = fadeOutAt(asParam(p), 4, 0.8);
    expect(p.cancelScheduledValues).toHaveBeenCalledWith(4);
    expect(p.setValueAtTime).toHaveBeenCalledWith(0.8, 4);
    expect(p.linearRampToValueAtTime).toHaveBeenCalledWith(0, 4 + CHOKE_FADE);
    expect(silentAt).toBe(4 + CHOKE_FADE);
  });
});

describe('the editor preview goes through the fades (ClipPreview)', () => {
  function previewRig() {
    const gainParam = param();
    const gain = { gain: gainParam, connect: vi.fn(), disconnect: vi.fn() };
    const src = {
      buffer: null as { duration: number } | null,
      onended: null as (() => void) | null,
      connect: vi.fn(() => gain), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(),
    };
    const destination = {};
    const ctx = {
      currentTime: 1, sampleRate: 48000, destination,
      createBufferSource: () => src,
      createGain: () => gain,
      createBuffer: (_ch: number, len: number, sr: number) => ({
        duration: len / sr, getChannelData: () => new Float32Array(len),
      }),
    };
    const preview = new ClipPreview(ctx as unknown as AudioContext);
    const clip = { left: new Float32Array(48000), right: new Float32Array(48000), sampleRate: 48000 };
    return { preview, clip, src, gain, gainParam, destination };
  }

  it('shapes its source with the slot\'s edges and plays outside the master bus', () => {
    const { preview, clip, src, gain, gainParam, destination } = previewRig();
    preview.play(clip, () => {});
    expect(preview.playing).toBe(true);
    expect(gainParam.setValueAtTime.mock.calls[0]![0]).toBe(0);              // starts from silence
    expect(gainParam.linearRampToValueAtTime.mock.calls.at(-1)![0]).toBe(0); // and ends there
    expect(src.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(destination);
    expect(src.start).toHaveBeenCalled();
  });

  it('fades a Stop from the level reached instead of cutting', () => {
    const { preview, clip, src, gainParam } = previewRig();
    preview.play(clip, () => {});
    preview.stop();
    expect(preview.playing).toBe(false);
    expect(gainParam.cancelScheduledValues).toHaveBeenCalled();
    const stopAt = (src.stop.mock.calls[0] as number[])[0]!;
    expect(stopAt).toBeGreaterThan(1); // scheduled past the fade, not now
  });

  it('reports a clip that ran out by itself, and not a replaced one', () => {
    const { preview, clip, src } = previewRig();
    const ended = vi.fn();
    preview.play(clip, ended);
    src.onended!();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(preview.playing).toBe(false);
  });
});
