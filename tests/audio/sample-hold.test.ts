import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SampleHold } from '../../src/audio/sample-hold';
import { SMOOTH_HZ, SMOOTH_Q_DB } from '../../src/audio/lfo';
import { makeMockAudioContext } from './mock-audio-context';

/**
 * The mod matrix's `random` source reaches the matrix smoothed
 * (mod-matrix.md REQ-random-steps-are-smoothed). Raw, every 16th was a
 * full-bandwidth step on whatever the route drove — into amp, measured through
 * the real graph at 95x the 3rd-difference floor of a held sine, once per 16th.
 */
describe('SampleHold (REQ-random-steps-are-smoothed)', () => {
  function build() {
    const ctx = makeMockAudioContext();
    const sh = new SampleHold(ctx as unknown as AudioContext);
    const src = ctx.createConstantSource.mock.results[0]!.value as {
      offset: { setValueAtTime: ReturnType<typeof vi.fn> };
      connect: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    const smooth = ctx.createBiquadFilter.mock.results[0]!.value as {
      type: string; frequency: { value: number }; Q: { value: number };
    };
    return { sh, src, smooth };
  }

  it('hands the matrix the smoother, fed by the held value — never the raw source', () => {
    const { sh, src, smooth } = build();
    expect(sh.out).toBe(smooth);
    expect(sh.out).not.toBe(src);
    expect(src.connect).toHaveBeenCalledWith(smooth);
    expect(src.start).toHaveBeenCalled();
  });

  it('smooths with the LFO\'s critically damped control lowpass', () => {
    const { smooth } = build();
    expect(smooth.type).toBe('lowpass');
    expect(smooth.frequency.value).toBe(SMOOTH_HZ);
    expect(smooth.Q.value).toBe(SMOOTH_Q_DB);
  });

  it('writes each roll at the tick\'s own time', () => {
    const { sh, src } = build();
    sh.roll(0.25, 3.5);
    expect(src.offset.setValueAtTime).toHaveBeenLastCalledWith(0.25, 3.5);
  });

  it('is what the engine gives the matrix as its random source', () => {
    // The engine is not built under the mock (see engine-stereo.test.ts), so the
    // wiring is pinned at the source: the matrix reads `out`, and rolls go
    // through `roll`, not a direct write on a raw ConstantSourceNode.
    const engine = readFileSync(fileURLToPath(new URL('../../src/audio/engine.ts', import.meta.url)), 'utf8');
    expect(engine).toContain('new SampleHold(this.ctx)');
    expect(engine).toContain('random: this.randomSource.out');
    expect(engine).not.toMatch(/randomSource\.offset/);
  });
});
