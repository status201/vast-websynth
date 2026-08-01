import { describe, it, expect, vi } from 'vitest';
import { LFO } from '../../src/audio/lfo';
import { makeMockAudioContext } from './mock-audio-context';

/**
 * The global LFO's destination routing and depth scaling (lfo.md REQ-1..REQ-5).
 *
 * `rampTo` is `setTargetAtTime`, so a destination's depth is read as the last
 * value that node's gain was targeted at. Only the selected destination is
 * non-zero — that *is* the routing switch, there is no `switch` statement.
 */

/** Construction order is fixed: off = every destination silent. */
function build() {
  const ctx = makeMockAudioContext();
  const lfo = new LFO(ctx as unknown as AudioContext);
  const osc = ctx.createOscillator.mock.results[0]!.value as { connect: ReturnType<typeof vi.fn> };
  const smooth = ctx.createBiquadFilter.mock.results[0]!.value as {
    type: string;
    frequency: { value: number };
    Q: { value: number };
    connect: ReturnType<typeof vi.fn>;
  };
  return { ctx, lfo, osc, smooth };
}

/** The most recent depth `rampTo` targeted this output's gain at. */
function depth(g: GainNode): number | undefined {
  const fn = g.gain.setTargetAtTime as unknown as ReturnType<typeof vi.fn>;
  return fn.mock.calls.at(-1)?.[0] as number | undefined;
}

function depths(lfo: LFO) {
  return {
    pitch: depth(lfo.toPitch),
    cutoff: depth(lfo.toCutoff),
    amp: depth(lfo.toAmp),
    pan: depth(lfo.toPan),
    shape: depth(lfo.toShape),
  };
}

describe('LFO destination routing', () => {
  it('boots silent on every destination', () => {
    const { lfo } = build();
    for (const g of [lfo.toPitch, lfo.toCutoff, lfo.toAmp, lfo.toPan, lfo.toShape]) {
      expect(g.gain.value).toBe(0);
    }
  });

  it('routes to exactly one destination at full depth', () => {
    const { lfo } = build();
    lfo.setAmount(1);

    lfo.setDest(1); // cutoff — ±24 semitones
    expect(depths(lfo)).toEqual({ pitch: 0, cutoff: 24, amp: 0, pan: 0, shape: 0 });

    lfo.setDest(2); // pitch — ±1200 cents
    expect(depths(lfo)).toEqual({ pitch: 1200, cutoff: 0, amp: 0, pan: 0, shape: 0 });

    lfo.setDest(3); // amp — ±50% around the tremolo VCA's base 1.0
    expect(depths(lfo)).toEqual({ pitch: 0, cutoff: 0, amp: 0.5, pan: 0, shape: 0 });

    lfo.setDest(5); // pan — ±1.0, hard L↔R (REQ-4)
    expect(depths(lfo)).toEqual({ pitch: 0, cutoff: 0, amp: 0, pan: 1, shape: 0 });

    lfo.setDest(6); // shape — ±0.5 of the POLY pole mix (REQ-7)
    expect(depths(lfo)).toEqual({ pitch: 0, cutoff: 0, amp: 0, pan: 0, shape: 0.5 });
  });

  it('switching away from pan re-centres the image', () => {
    const { lfo } = build();
    lfo.setAmount(1);
    lfo.setDest(5);
    expect(depth(lfo.toPan)).toBe(1);

    lfo.setDest(1);
    // Pan's own base value is 0 (centre), so a zero depth settles centred.
    expect(depth(lfo.toPan)).toBe(0);
  });

  it('off silences every destination', () => {
    const { lfo } = build();
    lfo.setAmount(1);
    lfo.setDest(5);
    lfo.setDest(0);
    expect(depths(lfo)).toEqual({ pitch: 0, cutoff: 0, amp: 0, pan: 0, shape: 0 });
  });

  it('scales depth by amount', () => {
    const { lfo } = build();
    lfo.setDest(5);
    lfo.setAmount(0.25);
    expect(depth(lfo.toPan)).toBe(0.25);
    lfo.setAmount(0.8); // the engine's clamped modWheel sum arrives here
    expect(depth(lfo.toPan)).toBeCloseTo(0.8);
  });

  it('clamps amount at full, so a summed mod wheel cannot overshoot', () => {
    const { lfo } = build();
    lfo.setDest(2);
    lfo.setAmount(1.3); // lfo.amount 0.8 + modWheel 0.5, unclamped
    expect(depth(lfo.toPitch)).toBe(1200); // not 1560
  });

  it('ignores a negative amount', () => {
    const { lfo } = build();
    lfo.setDest(5);
    lfo.setAmount(-1);
    expect(depth(lfo.toPan)).toBe(0);
  });
});

describe('LFO control-signal smoothing (REQ-5)', () => {
  it('smooths only the amplitude-domain destinations', () => {
    const { lfo, osc, smooth } = build();
    const direct = osc.connect.mock.calls.map((c) => c[0]);
    const smoothed = smooth.connect.mock.calls.map((c) => c[0]);

    // pitch/cutoff come straight off the oscillator — a stepped octave or
    // filter jump is a musical event, not a click.
    expect(direct).toContain(lfo.toPitch);
    expect(direct).toContain(lfo.toCutoff);
    expect(direct).not.toContain(lfo.toAmp);
    expect(direct).not.toContain(lfo.toPan);
    expect(direct).not.toContain(lfo.toShape);

    // amp/pan/shape go via the lowpass — a stepped gain is a click, and so is a
    // stepped filter *coefficient*, which is what shape moves (lfo.md REQ-7).
    expect(smoothed).toEqual([lfo.toAmp, lfo.toPan, lfo.toShape]);
    expect(direct).toContain(smooth);
  });

  it('is critically damped so a smoothed depth never overshoots', () => {
    const { smooth } = build();
    expect(smooth.type).toBe('lowpass');
    expect(smooth.frequency.value).toBe(200);
    expect(smooth.Q.value).toBe(0.5);
  });
});

describe('LFO rate and waveform', () => {
  it('maps the waveform index and clamps out-of-range indices', () => {
    const { ctx, lfo } = build();
    const osc = ctx.createOscillator.mock.results[0]!.value as { type: string };

    lfo.setWave(3);
    expect(osc.type).toBe('square');
    lfo.setWave(0);
    expect(osc.type).toBe('sine');
    lfo.setWave(99);
    expect(osc.type).toBe('square'); // clamped to the last entry
  });

  it('ramps rate rather than jumping', () => {
    const { ctx, lfo } = build();
    const osc = ctx.createOscillator.mock.results[0]!.value as {
      frequency: { setTargetAtTime: ReturnType<typeof vi.fn> };
    };
    lfo.setRate(12);
    expect(osc.frequency.setTargetAtTime).toHaveBeenCalledWith(12, expect.any(Number), expect.any(Number));
  });
});
