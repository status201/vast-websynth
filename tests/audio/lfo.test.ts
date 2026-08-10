import { describe, it, expect, vi } from 'vitest';
import { LFO } from '../../src/audio/lfo';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { SYNC_LABELS } from '../../src/utils/tempo';
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

/**
 * `LFO.bind` — the param wiring each LFO owns (lfo.md REQ-10/REQ-11, ADR-008).
 *
 * This lived as a closure inside the private `Engine.subscribeParams()` until
 * v7, where it was unreachable without a full AudioContext + worklet boot; the
 * mod-wheel sum was the spec's standing "not unit-pinned" open question. It is
 * a method now, so a mock context and a real bus are enough.
 */
describe('LFO.bind', () => {
  /** Two LFOs on one bus, wired exactly as the Engine wires them. */
  function pair() {
    const bus = new ParamBus();
    registerDefaults(bus);
    const one = build();
    const two = build();
    one.lfo.bind(bus, 'lfo', null, 0, 'master.modWheel');
    two.lfo.bind(bus, 'lfo2', null, 1);
    return { bus, one: one.lfo, two: two.lfo, oneCtx: one.ctx, twoCtx: two.ctx };
  }

  /** The frequency the LFO's oscillator was last ramped to. */
  function rateOf(ctx: ReturnType<typeof build>['ctx']): number | undefined {
    const osc = ctx.createOscillator.mock.results[0]!.value as {
      frequency: { setTargetAtTime: ReturnType<typeof vi.fn> };
    };
    return osc.frequency.setTargetAtTime.mock.calls.at(-1)?.[0] as number | undefined;
  }

  it('opens LFO 1 with the mod wheel and leaves LFO 2 alone (REQ-11)', () => {
    const { bus, one, two } = pair();
    bus.set('lfo.dest', 1);      // cutoff
    bus.set('lfo2.dest', 2);     // pitch
    bus.set('lfo.amount', 0.3);
    bus.set('lfo2.amount', 0.4);

    bus.set('master.modWheel', 0.5);

    // LFO 1: (0.3 + 0.5) of ±24 semitones.
    expect(depth(one.toCutoff)).toBeCloseTo(0.8 * 24, 6);
    // LFO 2: its own 0.4 of ±1200 cents — the wheel never reached it.
    expect(depth(two.toPitch)).toBeCloseTo(0.4 * 1200, 6);
  });

  it('still clamps the summed LFO 1 amount at full (edge, REQ-2)', () => {
    const { bus, one } = pair();
    bus.set('lfo.dest', 2);      // pitch
    bus.set('lfo.amount', 0.8);
    bus.set('master.modWheel', 0.9);
    expect(depth(one.toPitch)).toBeCloseTo(1200, 6); // not 1.7 * 1200
  });

  it('tempo-locks each LFO independently off transport.bpm (REQ-9, REQ-10)', () => {
    const { bus, oneCtx, twoCtx } = pair();
    bus.set('transport.bpm', 120);
    bus.set('lfo.rate', 7);
    bus.set('lfo2.rate', 7);

    bus.set('lfo2.sync', SYNC_LABELS.indexOf('1/4'));
    expect(rateOf(twoCtx)).toBeCloseTo(2, 6);   // a 1/4 at 120 BPM
    expect(rateOf(oneCtx)).toBeCloseTo(7, 6);   // still free-running

    bus.set('transport.bpm', 60);
    expect(rateOf(twoCtx)).toBeCloseTo(1, 6);
    expect(rateOf(oneCtx)).toBeCloseTo(7, 6);
  });

  it('returns to the stored rate when sync goes back to free (REQ-9)', () => {
    const { bus, twoCtx } = pair();
    bus.set('transport.bpm', 120);
    bus.set('lfo2.rate', 7);
    bus.set('lfo2.sync', SYNC_LABELS.indexOf('1/8'));
    expect(rateOf(twoCtx)).toBeCloseTo(4, 6);

    bus.set('lfo2.sync', 0);
    expect(rateOf(twoCtx)).toBeCloseTo(7, 6);
    expect(bus.get('lfo2.rate')).toBe(7);       // never rewritten
  });

  it('leaves both LFOs silent at their defaults (REQ-10, ADR-006)', () => {
    const { one, two } = pair();
    for (const d of [depths(one), depths(two)]) {
      expect(d).toEqual({ pitch: 0, cutoff: 0, amp: 0, pan: 0, shape: 0 });
    }
  });

  it('sums two LFOs pointed at one destination (REQ-13, edge)', () => {
    const { bus, one, two } = pair();
    bus.set('lfo.dest', 5);      // pan, on both — only a hand-authored file can
    bus.set('lfo2.dest', 5);     // do this; the panel greys it out (REQ-12)
    bus.set('lfo.amount', 1);
    bus.set('lfo2.amount', 1);
    // Each contributes its own full ±1; the panner clamps the sum.
    expect(depth(one.toPan)).toBe(1);
    expect(depth(two.toPan)).toBe(1);
  });
});
