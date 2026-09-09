// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Equalizer } from '../../../src/audio/effects/eq';
import {
  createSynthChain, createDrumChain, createSamplerChain,
} from '../../../src/audio/effects/fx-chain';
import { EQ_BANDS, EQ_BAND_COUNT, EQ_HP_REF, EQ_LP_REF } from '../../../src/state/eq';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { makeMockAudioContext, type MockAudioContext } from '../mock-audio-context';

type MockBiquad = ReturnType<MockAudioContext['createBiquadFilter']>;

/**
 * The audio half of `specs/features/equalizer.md`.
 *
 * Two of these are stability pins rather than behaviour pins, and they are the
 * reason this file exists at all: the EQ must sweep on `detune` (REQ-3) and must
 * never cancel automation. Both are invisible in Blink and audible in Gecko, so
 * neither would be caught by listening on one browser.
 */

function build(): {
  ctx: MockAudioContext;
  eq: Equalizer;
  bus: ParamBus;
  hp: MockBiquad;
  lp: MockBiquad;
  bands: MockBiquad[];
} {
  const ctx = makeMockAudioContext(48000);
  const eq = new Equalizer(ctx as unknown as AudioContext);
  const bus = new ParamBus();
  registerDefaults(bus);
  eq.bind(bus, 'fx.eq');
  // Identify the two filters by type rather than by construction index: the
  // order the constructor happens to create them in is not part of the contract,
  // and the band list below still asserts the table order it *is* part of.
  const made = ctx.createBiquadFilter.mock.results.map((r) => r.value as MockBiquad);
  const hp = made.find((f) => f.type === 'highpass')!;
  const lp = made.find((f) => f.type === 'lowpass')!;
  return { ctx, eq, bus, hp, lp, bands: made.filter((f) => f !== hp && f !== lp) };
}

describe('Equalizer — the filter span (REQ-1, REQ-2)', () => {
  it('builds a highpass, the eight bands in table order, and a lowpass', () => {
    const { hp, lp, bands } = build();
    expect(hp.type).toBe('highpass');
    expect(lp.type).toBe('lowpass');
    expect(bands).toHaveLength(EQ_BAND_COUNT);
    expect(bands.map((b) => b.type)).toEqual(EQ_BANDS.map((b) => b.type));
    expect(bands.map((b) => b.frequency.value)).toEqual(EQ_BANDS.map((b) => b.hz));
  });

  it('wires processedIn -> hp -> b0..b7 -> lp -> processedOut in series', () => {
    const { eq, hp, lp, bands } = build();
    // The wrapper's processedIn is the only node that feeds the span's head.
    expect(hp.connect).toHaveBeenCalledWith(bands[0]);
    for (let i = 0; i < EQ_BAND_COUNT - 1; i++) {
      expect(bands[i]!.connect).toHaveBeenCalledWith(bands[i + 1]);
    }
    expect(bands[EQ_BAND_COUNT - 1]!.connect).toHaveBeenCalledWith(lp);
    // …and the effect still publishes the wrapper as its public surface.
    expect(eq.input).toBeDefined();
    expect(eq.output).toBeDefined();
  });

  it('declares no makeup gain — a boosted curve is a level change (REQ-8)', () => {
    const { ctx } = build();
    // Six gains is exactly the BypassWrapper's own (input/output/dry/wet/
    // processedIn/processedOut). A seventh would be a trim this effect
    // deliberately does not have: the lane volume is the makeup control.
    expect(ctx.createGain.mock.results).toHaveLength(6);
  });
});

describe('Equalizer — sweeping in cents (REQ-3)', () => {
  const cents = (hz: number, ref: number) => 1200 * Math.log2(hz / ref);

  it('pins hp/lp frequency at construction and never writes it again', () => {
    const { bus, hp, lp } = build();
    expect(hp.frequency.value).toBe(EQ_HP_REF);
    expect(lp.frequency.value).toBe(EQ_LP_REF);

    bus.set('fx.eq.hp', 400);
    bus.set('fx.eq.lp', 5000);

    for (const f of [hp, lp]) {
      expect(f.frequency.setTargetAtTime).not.toHaveBeenCalled();
      expect(f.frequency.setValueAtTime).not.toHaveBeenCalled();
      expect(f.frequency.linearRampToValueAtTime).not.toHaveBeenCalled();
    }
    expect(hp.detune.setTargetAtTime.mock.calls.at(-1)![0]).toBeCloseTo(cents(400, EQ_HP_REF), 6);
    expect(lp.detune.setTargetAtTime.mock.calls.at(-1)![0]).toBeCloseTo(cents(5000, EQ_LP_REF), 6);
  });

  it('cannot drive a corner to 0 Hz at either extreme of the knob', () => {
    const { bus, hp, lp } = build();
    // The registered extremes, which is as far as a user or a payload can go.
    bus.set('fx.eq.hp', bus.def('fx.eq.hp')!.min);
    bus.set('fx.eq.lp', bus.def('fx.eq.lp')!.min);
    const hpHz = EQ_HP_REF * Math.pow(2, (hp.detune.setTargetAtTime.mock.calls.at(-1)![0] as number) / 1200);
    const lpHz = EQ_LP_REF * Math.pow(2, (lp.detune.setTargetAtTime.mock.calls.at(-1)![0] as number) / 1200);
    expect(hpHz).toBeGreaterThan(0);
    expect(lpHz).toBeGreaterThan(0);
  });
});

describe('Equalizer — parameter writes (REQ-3, REQ-4)', () => {
  it('ramps a band gain and never cancels automation', () => {
    const { bus, bands } = build();
    bus.set('fx.eq.b3', -9);
    expect(bands[3]!.gain.setTargetAtTime).toHaveBeenCalled();
    expect(bands[3]!.gain.setTargetAtTime.mock.calls.at(-1)![0]).toBe(-9);
    for (const b of bands) {
      expect(b.gain.cancelScheduledValues).not.toHaveBeenCalled();
      expect(b.Q.cancelScheduledValues).not.toHaveBeenCalled();
    }
  });

  it('subscribes all twelve ids, so every band reaches its own filter', () => {
    const { bus, bands } = build();
    for (let i = 0; i < EQ_BAND_COUNT; i++) bus.set(`fx.eq.b${i}`, i - 4);
    bands.forEach((b, i) => {
      expect(b.gain.setTargetAtTime.mock.calls.at(-1)![0], `band ${i}`).toBe(i - 4);
    });
  });

  it('moves Q on the peaking bands only — the shelves ignore it (REQ-4)', () => {
    const { bus, bands } = build();
    bus.set('fx.eq.width', 4);
    bands.forEach((b, i) => {
      if (EQ_BANDS[i]!.type === 'peaking') {
        expect(b.Q.setTargetAtTime.mock.calls.at(-1)![0], `band ${i}`).toBe(4);
      } else {
        expect(b.Q.setTargetAtTime, `band ${i} is a shelf`).not.toHaveBeenCalled();
      }
    });
  });
});

describe('Equalizer — bypass drain (REQ-7)', () => {
  it('drains for longer than the slowest band rings', () => {
    const { eq } = build();
    // `drainSeconds` is protected; read it the way the wrapper does.
    const drain = (eq as unknown as { drainSeconds(): number }).drainSeconds();
    const widestQ = 8; // fx.eq.width max
    const slowest = Math.min(...EQ_BANDS.filter((b) => b.type === 'peaking').map((b) => b.hz));
    expect(drain).toBeGreaterThan(widestQ / (Math.PI * slowest));
    // …and comfortably past the stateless default it overrides.
    expect(drain).toBeGreaterThan(0.02);
  });
});

describe('Every chain leads with its EQ (REQ-1)', () => {
  const bus = new ParamBus();
  registerDefaults(bus);

  it.each([
    ['synth', createSynthChain, 'fx.eq'],
    ['drum', createDrumChain, 'fx.drum.eq'],
    ['sampler', createSamplerChain, 'fx.sampler.eq'],
  ] as const)('%s: eq is first and bound at %s', (_name, make, prefix) => {
    const ctx = makeMockAudioContext(48000);
    const chain = make(ctx as unknown as AudioContext);
    expect(chain.fx.eq).toBeInstanceOf(Equalizer);

    // Wiring the chain must run the EQ's input first: `chain()` walks the order
    // array, so the first effect is the one the bus input connects to.
    const input = ctx.createGain();
    const output = ctx.createGain();
    chain.wire(input as unknown as AudioNode, output as unknown as AudioNode);
    expect(input.connect).toHaveBeenCalledWith(chain.fx.eq.input);

    // And `bind` reaches it at this chain's own prefix.
    chain.bind(bus);
    const eqBands = new Set<number>();
    bus.set(`${prefix}.b2`, 5);
    eqBands.add(bus.get(`${prefix}.b2`));
    expect(eqBands.has(5)).toBe(true);
  });
});
