import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clipFades, fadeOutAt, SAMPLER_ATTACK, CHOKE_FADE } from '../../src/audio/clip-fades';

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

describe('the editor preview goes through the fades', () => {
  it('shapes its source with clipFades, and fades a Stop instead of cutting', () => {
    // The modal is not built under the mock, so the wiring is pinned at the
    // source, the way engine-stereo.test.ts pins forceStereo.
    const src = readFileSync(fileURLToPath(new URL('../../src/ui/components/record-sound-modal.ts', import.meta.url)), 'utf8');
    expect(src).toContain('clipFades(gain.gain, t, node.buffer.duration)');
    expect(src).toContain('fadeOutAt(fade.gain.gain, at, fade.levelAt(at))');
    expect(src).not.toContain('node.connect(engine.ctx.destination)');
  });
});
