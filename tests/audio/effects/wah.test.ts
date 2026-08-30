import { describe, it, expect } from 'vitest';
import { Wah, makeupFor } from '../../../src/audio/effects/wah';
import { makeMockAudioContext, type MockAudioContext } from '../mock-audio-context';

/**
 * effects.md REQ-11 (v9): the wah sweeps its bandpass in **cents**, not Hz.
 *
 * The v1 mapping modulated `bp.frequency` by `depth * 1500` linear Hz around a
 * 622.25 Hz centre, so from depth 0.415 up the LFO trough drove the computed
 * frequency to the AudioParam's 0 Hz floor — where an RBJ bandpass has
 * `alpha = 0`, an all-zero numerator and a double pole at z = 1. Measured
 * through the real graph that was a ~10x jump in peak single-sample step and
 * the burst detector going from silent to firing. No demo plays the wah over the
 * cliff today (only Bunk at 0.11 and Run Away at 0.35 have `fx.wah.on: 1`), but
 * nine *stage* it at 0.4-0.6 for a player to open, and the param default of 0.4
 * sits two percent under it.
 *
 * These pin the contract that makes it unreachable: the sweep is `detune`, and
 * `frequency` is a construction-time constant. `frequency * 2^(detune/1200)`
 * cannot reach zero however deep the sweep goes.
 */
describe('Wah sweeps in cents (effects.md REQ-11)', () => {
  const CENTER_HZ = 440 * Math.pow(2, (75 - 69) / 12); // midiToHz(75) = 622.25
  /** The mapping REQ-11 specifies, restated so the test fails if it drifts. */
  const cents = (d: number) => 1200 * Math.log2(1 + (d * 1500) / CENTER_HZ);

  function build() {
    const ctx = makeMockAudioContext(48000);
    const wah = new Wah(ctx as unknown as AudioContext);
    // createBiquadFilter is called once by the Wah (the wrapper uses gains only).
    const bp = ctx.createBiquadFilter.mock.results[0]!.value as ReturnType<
      MockAudioContext['createBiquadFilter']
    >;
    // BypassWrapper builds six gains first; then the Wah's lfoDepth, then makeup.
    const gains = ctx.createGain.mock.results.map((r) => r.value);
    return { ctx, wah, bp, lfoDepth: gains[6]!, makeup: gains[7]! };
  }

  it('modulates detune, never frequency, and pins frequency to the centre', () => {
    const { bp, lfoDepth } = build();

    expect(bp.type).toBe('bandpass');
    expect(bp.frequency.value).toBeCloseTo(CENTER_HZ, 2);
    // frequency is written once at construction and never automated
    expect(bp.frequency.setTargetAtTime).not.toHaveBeenCalled();
    expect(bp.frequency.setValueAtTime).not.toHaveBeenCalled();
    // the LFO's depth gain lands on detune
    expect(lfoDepth.connect).toHaveBeenCalledWith(bp.detune);
    expect(lfoDepth.connect).not.toHaveBeenCalledWith(bp.frequency);
  });

  it('sweeps symmetrically in octaves and never approaches 0 Hz', () => {
    const { wah, lfoDepth } = build();

    // depth 1 is the widest the param allows (params.ts: fx.wah.depth max 1)
    wah.setDepth(1);
    const swing = lfoDepth.gain.setTargetAtTime.mock.calls.at(-1)![0] as number;
    expect(swing).toBeCloseTo(cents(1), 6);

    const top = CENTER_HZ * Math.pow(2, swing / 1200);
    const bottom = CENTER_HZ * Math.pow(2, -swing / 1200);
    expect(bottom).toBeGreaterThan(150); // the old mapping reached 0 here
    expect(top / CENTER_HZ).toBeCloseTo(CENTER_HZ / bottom, 6); // symmetric in log f
  });

  it('leaves the top of a stored sweep where it was (0.4 default, 0.18 in Around)', () => {
    const { wah, lfoDepth } = build();
    const topFor = (d: number) => {
      wah.setDepth(d);
      const c = lfoDepth.gain.setTargetAtTime.mock.calls.at(-1)![0] as number;
      return {
        top: CENTER_HZ * Math.pow(2, c / 1200),
        bottom: CENTER_HZ * Math.pow(2, -c / 1200),
      };
    };

    // the old linear mapping's top was CENTER + depth * 1500 — unchanged
    const d04 = topFor(0.4);
    expect(d04.top).toBeCloseTo(CENTER_HZ + 0.4 * 1500, 6);
    expect(d04.bottom).toBeCloseTo(317, 0); // was 22 Hz

    const d018 = topFor(0.18);
    expect(d018.top).toBeCloseTo(CENTER_HZ + 0.18 * 1500, 6);
    expect(d018.bottom).toBeCloseTo(434, 0); // was 352 Hz
  });

  it('crossing the old 0.415 cliff is no longer a special case', () => {
    const { wah, lfoDepth } = build();
    const bottomFor = (d: number) => {
      wah.setDepth(d);
      const c = lfoDepth.gain.setTargetAtTime.mock.calls.at(-1)![0] as number;
      return CENTER_HZ * Math.pow(2, -c / 1200);
    };
    // continuous and monotonic across the depth where the old mapping clamped
    const b = [0.35, 0.4, 0.42, 0.45, 0.6].map(bottomFor);
    for (let i = 1; i < b.length; i++) expect(b[i]!).toBeLessThan(b[i - 1]!);
    expect(Math.min(...b)).toBeGreaterThan(200);
  });
});

/**
 * effects.md REQ-12 (v10): toggling an effect must not step the level. The wah
 * is the only insert with no `setMix`, so enabling it replaces the whole signal
 * with a Q ~ 4 bandpass — measured at -13 to -15.5 dB going in and +19 dB coming
 * back out, in 10-20 ms. Continuous samples, but plainly a click. The bandpass
 * now carries makeup for its own insertion loss.
 */
describe('Wah makeup gain (effects.md REQ-12)', () => {
  function build() {
    const ctx = makeMockAudioContext(48000);
    const wah = new Wah(ctx as unknown as AudioContext);
    const gains = ctx.createGain.mock.results.map((r) => r.value);
    return { ctx, wah, bp: ctx.createBiquadFilter.mock.results[0]!.value, makeup: gains[7]! };
  }

  it('follows 2.5*sqrt(Q) and is capped at x8', () => {
    expect(makeupFor(0.5)).toBeCloseTo(2.5 * Math.SQRT1_2, 6);   // ~ +5 dB
    expect(makeupFor(4)).toBeCloseTo(5, 6);                      // ~ +14 dB, the default
    expect(makeupFor(20)).toBe(8);                               // capped, not 11.18
    expect(makeupFor(1e6)).toBe(8);
    expect(makeupFor(0)).toBe(0);
  });

  it('is spliced between the bandpass and the wrapper, and seeded from the initial Q', () => {
    const { bp, makeup } = build();
    expect(makeup.gain.value).toBeCloseTo(makeupFor(4), 6);      // bp.Q.value is 4
    expect(bp.connect).toHaveBeenCalledWith(makeup);
  });

  it('tracks the Q knob, smoothed like any other control (REQ-2b)', () => {
    const { wah, makeup } = build();
    wah.setQ(9);
    const call = makeup.gain.setTargetAtTime.mock.calls.at(-1)!;
    expect(call[0]).toBeCloseTo(makeupFor(9), 6);
    expect(call[2]).toBe(0.02);                                  // RAMP_SMOOTH
  });
});
