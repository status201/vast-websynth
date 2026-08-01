import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * The POLY filter model (`specs/features/filter-models.md`), driven through the
 * real `public/worklets/ladder-filter.js` under Node — both models live in that
 * one file, selected by the `model` AudioParam (ADR-016).
 *
 * Asserts physics, not golden samples: the bass-preservation claim that is the
 * whole reason the model exists, boundedness, what each SHAPE anchor passes,
 * and that the two models cannot corrupt each other's state.
 */

const SR = 48000;
const BLOCK = 128;

const LADDER = 0;
const POLY = 1;

interface ProcessorLike {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
}

let Processor: new () => ProcessorLike;

beforeAll(async () => {
  vi.stubGlobal('sampleRate', SR);
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: null, postMessage: () => {} };
  });
  vi.stubGlobal('registerProcessor', (_name: string, cls: unknown) => {
    Processor = cls as typeof Processor;
  });
  await import('../../public/worklets/ladder-filter.js' as string);
});

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const d: Record<string, number> = {
    cutoffNote: 90, resonance: 0, drive: 1, model: POLY, shape: 0, ...over,
  };
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, new Float32Array([v])]));
}

function run(
  proc: ProcessorLike,
  params: Record<string, Float32Array>,
  gen: (n: number) => number,
  blocks: number,
): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  let n = 0;
  for (let b = 0; b < blocks; b++) {
    const inCh = new Float32Array(BLOCK);
    const outCh = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++, n++) inCh[i] = gen(n);
    proc.process([[inCh]], [[outCh]], params);
    out.set(outCh, b * BLOCK);
  }
  return out;
}

const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const allFinite = (a: Float32Array) => a.every((v) => Number.isFinite(v));

/** Peak of the settled tail — skips the filter's startup transient. */
function tailPeak(a: Float32Array, frac = 0.3): number {
  const start = Math.floor(a.length * (1 - frac));
  let m = 0;
  for (let i = start; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
}
const dB = (x: number) => 20 * Math.log10(x);
function tailRms(a: Float32Array, frac = 0.25): number {
  const start = Math.floor(a.length * (1 - frac));
  let s = 0;
  for (let i = start; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / (a.length - start));
}

const AMP = 0.5;
/** 60 Hz — well below the note-90 (~1.4 kHz) cutoff, so it reads the passband. */
const subCutoff = (n: number) => AMP * Math.sin((2 * Math.PI * 60 * n) / SR);
/** Amplitude of the settled passband tone at a given resonance, per model. */
const lowEnd = (model: number, resonance: number) =>
  tailPeak(run(new Processor(), makeParams({ model, resonance }), subCutoff, 200));

let seed = 1;
function noise(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x3fffffff - 1;
}

describe('POLY filter model — bass preservation (REQ-3)', () => {
  it('holds its low end as resonance rises, where the ladder loses ~7 dB', () => {
    // The headline claim, and the entire reason for a second model. Same input,
    // same cutoff, resonance swept from nothing to maximum.
    const ladderLoss = dB(lowEnd(LADDER, 4.2) / lowEnd(LADDER, 0));
    const polyChange = dB(lowEnd(POLY, 4.2) / lowEnd(POLY, 0));

    // The ladder's feedback subtraction costs it the bottom end.
    expect(ladderLoss).toBeLessThan(-6);
    // POLY does not merely hold — the saturating feedback under-subtracts, so
    // it gains a little. What matters is that it never sags.
    expect(polyChange).toBeGreaterThan(0);
    // The two diverge by most of an order of magnitude in amplitude.
    expect(polyChange - ladderLoss).toBeGreaterThan(6);
  });

  it('rises monotonically with resonance rather than sagging', () => {
    const steps = [0, 0.5, 1, 2, 3, 4.2].map((r) => lowEnd(POLY, r));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
    }
  });

  it('is level-matched to the ladder at the default resonance (REQ-10)', () => {
    // POLY_TRIM exists so that flipping the model switch on an untouched patch
    // is an A/B of character, not of loudness.
    const diff = Math.abs(dB(lowEnd(POLY, 0.5) / lowEnd(LADDER, 0.5)));
    expect(diff).toBeLessThan(0.5);
  });
});

describe('POLY filter model — stability (REQ-5)', () => {
  it('stays finite and bounded under full-scale noise at every extreme', () => {
    // Worst case by construction: full-scale input, maximum drive, maximum
    // resonance, and each SHAPE anchor in turn (HP24 sums the widest mix).
    for (const shape of [0, 0.25, 0.5, 0.75, 1]) {
      seed = 1;
      const out = run(
        new Processor(),
        makeParams({ resonance: 4.2, drive: 8, cutoffNote: 84, shape }),
        noise,
        400,
      );
      expect(allFinite(out), `shape ${shape}`).toBe(true);
      expect(peak(out), `shape ${shape}`).toBeLessThan(24);
    }
  });

  it('self-oscillates and self-limits at maximum resonance', () => {
    const impulse = (n: number) => (n === 0 ? 1 : 0);
    const hi = run(new Processor(), makeParams({ resonance: 4.2, cutoffNote: 72 }), impulse, 200);
    const lo = run(new Processor(), makeParams({ resonance: 0, cutoffNote: 72 }), impulse, 200);

    expect(allFinite(hi)).toBe(true);
    expect(peak(hi)).toBeLessThan(24); // bounded — the feedback sat() limits it
    expect(tailRms(hi)).toBeGreaterThan(tailRms(lo) * 10);
  });
});

describe('POLY filter model — SHAPE (REQ-6)', () => {
  // Cutoff note 84 ≈ 1046 Hz, with a probe tone two-and-a-bit octaves either
  // side of it, so each anchor's stop-band is unambiguous.
  const low = (n: number) => AMP * Math.sin((2 * Math.PI * 120 * n) / SR);
  const high = (n: number) => AMP * Math.sin((2 * Math.PI * 8000 * n) / SR);
  const at = (shape: number, gen: (n: number) => number) =>
    tailPeak(run(new Processor(), makeParams({ cutoffNote: 84, shape }), gen, 200));

  it('sweeps from low-pass to high-pass', () => {
    // LP24: passes the low tone, kills the high one.
    expect(at(0, low)).toBeGreaterThan(0.2);
    expect(at(0, high)).toBeLessThan(0.01);

    // HP24: exactly the other way round.
    expect(at(1, high)).toBeGreaterThan(0.2);
    expect(at(1, low)).toBeLessThan(0.01);
  });

  it('band-passes in the middle, rejecting both ends', () => {
    const bp = 2 / 3;
    expect(at(bp, low)).toBeLessThan(at(0, low) / 3);
    expect(at(bp, high)).toBeLessThan(at(1, high) / 2);
  });

  it('rolls off less steeply at LP12 than at LP24', () => {
    // The second anchor is a shallower low-pass, so more of the high tone
    // survives — that is what makes it a distinct, useful position.
    expect(at(1 / 3, high)).toBeGreaterThan(at(0, high));
  });

  it('hoists a block-constant shape identically to a length-1 array (REQ-8)', () => {
    const gen = (n: number) => 0.4 * Math.sin((2 * Math.PI * 300 * n) / SR);
    const base = makeParams({ resonance: 2, cutoffNote: 84 });
    const full = { ...base, shape: new Float32Array(BLOCK).fill(0.4) };
    const one = makeParams({ resonance: 2, cutoffNote: 84, shape: 0.4 });

    const procFull = new Processor();
    const procOne = new Processor();
    expect(run(procFull, full, gen, 20)).toEqual(run(procOne, one, gen, 20));

    // Change the constant → the per-block cache must recompute, and the two
    // array shapes must still agree on the following blocks.
    const full8 = { ...base, shape: new Float32Array(BLOCK).fill(0.8) };
    const one8 = makeParams({ resonance: 2, cutoffNote: 84, shape: 0.8 });
    expect(run(procFull, full8, gen, 20)).toEqual(run(procOne, one8, gen, 20));
  });

  it('tracks a varying shape per-sample — the hoist does not fire', () => {
    // LP24 for the first half of every block, HP24 for the second. If the hoist
    // wrongly fired it would use shape[0] = 0 throughout and block the tone.
    const high8k = (n: number) => AMP * Math.sin((2 * Math.PI * 8000 * n) / SR);
    const varying = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) varying[i] = i < BLOCK / 2 ? 0 : 1;

    const base = makeParams({ cutoffNote: 84 });
    const mixed = run(new Processor(), { ...base, shape: varying }, high8k, 30);
    const allLp = run(new Processor(), makeParams({ cutoffNote: 84, shape: 0 }), high8k, 30);

    expect(peak(mixed)).toBeGreaterThan(peak(allLp) * 3);
  });
});

describe('POLY filter model — model switching (REQ-9)', () => {
  const gen = (n: number) => 0.5 * Math.sin((2 * Math.PI * 220 * n) / SR);
  const opts = { resonance: 3, drive: 2, cutoffNote: 78 };

  it('stays finite across a switch in both directions', () => {
    const proc = new Processor();
    for (const model of [LADDER, POLY, LADDER, POLY, LADDER]) {
      const out = run(proc, makeParams({ ...opts, model }), gen, 8);
      expect(allFinite(out), `model ${model}`).toBe(true);
      expect(peak(out), `model ${model}`).toBeLessThan(24);
    }
  });

  it('resumes the ladder from its pole states, not from pre-POLY history', () => {
    // POLY never reads the ladder-only sat() carries, so without the per-block
    // re-prime the ladder would come back on carries left over from before the
    // POLY episode. Give one processor a loud LADDER history and the other
    // none, then settle both through the *same* silent POLY passage: the pole
    // states decay to nothing either way, so if the carries are rebuilt from
    // those states the loud history is forgotten and the two agree. Without the
    // re-prime the first processor keeps carries near ±1 while the second holds
    // zeros, and they diverge.
    const loud = (n: number) => 0.9 * Math.sin((2 * Math.PI * 110 * n) / SR);
    const silence = () => 0;

    const withHistory = new Processor();
    const fresh = new Processor();

    run(withHistory, makeParams({ ...opts, model: LADDER }), loud, 20);

    // Zero resonance so the states decay away rather than ringing on.
    const settle = makeParams({ ...opts, model: POLY, resonance: 0 });
    run(withHistory, settle, silence, 200);
    run(fresh, settle, silence, 200);

    const a = run(withHistory, makeParams({ ...opts, model: LADDER }), gen, 8);
    const b = run(fresh, makeParams({ ...opts, model: LADDER }), gen, 8);
    expect(peak(a)).toBeGreaterThan(0.01); // the comparison is on real signal
    // Verified to discriminate: dropping the re-prime moves these apart by
    // ~2.4e-2, some 6% of peak, so the threshold has five orders of margin.
    // (Compared by magnitude rather than with toEqual: the settled states leave
    // a signed zero on one side, which is equality noise, not a difference.)
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBeLessThan(1e-7);
  });

  it('keeps the idle gate working for both models (REQ-13)', () => {
    const params = makeParams({ ...opts, model: POLY });
    const proc = new Processor();
    expect(peak(run(proc, params, gen, 10))).toBeGreaterThan(0);

    proc.port.onmessage!({ data: false });
    expect(peak(run(proc, params, gen, 10))).toBe(0); // hot input, silent output

    proc.port.onmessage!({ data: true });
    // Deactivation zeroed the state, so the restart matches a fresh processor.
    expect(run(proc, params, gen, 10)).toEqual(run(new Processor(), params, gen, 10));
  });
});
