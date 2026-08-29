import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Drives the real `public/worklets/compressor.js` processor under Node by
 * stubbing the AudioWorklet globals before importing it. These tests assert
 * physics (static curve, stereo link, boundedness), not golden samples —
 * tolerances are deliberately loose.
 */

const SR = 48000;
const BLOCK = 128;

interface ProcessorLike {
  port: { postMessage: ReturnType<typeof vi.fn> };
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
}

let Processor: new (options: { processorOptions: { mode: 'fet' | 'vca' } }) => ProcessorLike;

beforeAll(async () => {
  vi.stubGlobal('sampleRate', SR);
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      port = { postMessage: vi.fn(), onmessage: null };
    },
  );
  vi.stubGlobal('registerProcessor', (_name: string, cls: unknown) => {
    Processor = cls as typeof Processor;
  });
  await import('../../public/worklets/compressor.js' as string);
});

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const d: Record<string, number> = {
    threshold: -18, ratio: 4, attack: 0.003, release: 0.3, autoRelease: 0, makeup: 0, ...over,
  };
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, new Float32Array([v])]));
}

/** Run `blocks` blocks of a stereo sine and return the final output block. */
function runSine(
  proc: ProcessorLike,
  params: Record<string, Float32Array>,
  ampL: number,
  ampR: number,
  blocks: number,
  freq = 1000,
): { outL: Float32Array; outR: Float32Array } {
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  let n = 0;
  for (let b = 0; b < blocks; b++) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++, n++) {
      const s = Math.sin((2 * Math.PI * freq * n) / SR);
      inL[i] = ampL * s;
      inR[i] = ampR * s;
    }
    proc.process([[inL, inR]], [[outL, outR]], params);
  }
  return { outL, outR };
}

const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
const db = (lin: number) => 20 * Math.log10(lin);

describe('hardware-compressor worklet DSP', () => {
  it('passes sub-threshold vca signal through at unity', () => {
    const proc = new Processor({ processorOptions: { mode: 'vca' } });
    // -40 dB peak, threshold -18: well below the knee.
    const { outL } = runSine(proc, makeParams(), 0.01, 0.01, 30);
    expect(peak(outL)).toBeGreaterThan(0.0099);
    expect(peak(outL)).toBeLessThan(0.0101);
  });

  it('lands on the vca static curve at steady state', () => {
    const proc = new Processor({ processorOptions: { mode: 'vca' } });
    const params = makeParams({ threshold: -20, ratio: 4, attack: 0.001, release: 0.3 });
    // 0 dBFS in, 20 dB over: expected out ≈ -20 + 20/4 = -15 dB.
    const { outL } = runSine(proc, params, 1, 1, 100);
    expect(db(peak(outL))).toBeGreaterThan(-16.5);
    expect(db(peak(outL))).toBeLessThan(-13.5);
  });

  it('is stereo-linked: a loud left channel compresses the right', () => {
    const proc = new Processor({ processorOptions: { mode: 'vca' } });
    const params = makeParams({ threshold: -20, ratio: 10, attack: 0.001 });
    // R alone (-20 dB peak) sits at the threshold and would barely compress.
    const { outR } = runSine(proc, params, 1, 0.1, 100);
    expect(db(peak(outR))).toBeLessThan(db(0.1) - 10);
  });

  it('fet output is bounded and DC-free under all-buttons smashing', () => {
    const proc = new Processor({ processorOptions: { mode: 'fet' } });
    const params = makeParams({ threshold: -30, ratio: 100, attack: 0.0002, release: 0.1, makeup: 12 });
    // 750 Hz = exactly 2 cycles per 128-frame block, so the block mean of the
    // (DC-free) signal itself is 0 and any residual mean is actual DC offset.
    const { outL } = runSine(proc, params, 1, 1, 100, 750);
    expect(peak(outL)).toBeLessThan(1);
    expect(Math.abs(mean(outL))).toBeLessThan(0.02);
  });

  it('fet feedback topology softens the effective ratio relative to the vca', () => {
    const fet = new Processor({ processorOptions: { mode: 'fet' } });
    const vca = new Processor({ processorOptions: { mode: 'vca' } });
    const params = () => makeParams({ threshold: -20, ratio: 4, attack: 0.001, release: 0.3 });
    const fetOut = runSine(fet, params(), 0.5, 0.5, 100).outL;
    const vcaOut = runSine(vca, params(), 0.5, 0.5, 100).outL;
    // The feedback detector softens the effective ratio, so the fet output is
    // hotter than the vca's for identical settings — but both compress.
    expect(db(peak(fetOut))).toBeGreaterThan(db(peak(vcaOut)));
    expect(db(peak(vcaOut))).toBeLessThan(db(0.5) - 3);
  });

  it('posts gain reduction on the port while compressing, and goes quiet when idle', () => {
    const proc = new Processor({ processorOptions: { mode: 'vca' } });
    runSine(proc, makeParams({ threshold: -20, ratio: 10, attack: 0.001 }), 1, 1, 30);
    const posts = proc.port.postMessage.mock.calls;
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[posts.length - 1]![0]).toBeGreaterThan(1);

    // Long silence (~3.2 s): gr fully decays, messages stop (after the
    // trailing near-zero one).
    runSine(proc, makeParams(), 0, 0, 1200);
    const after = proc.port.postMessage.mock.calls.length;
    runSine(proc, makeParams(), 0, 0, 100);
    expect(proc.port.postMessage.mock.calls.length).toBe(after);
  });
});

/**
 * Sustain + transients, so the detector exercises attack, release and the
 * program-dependent blend rather than settling on one steady gain.
 */
function fillMusical(
  inL: Float32Array,
  inR: Float32Array,
  n0: number,
  ampL: number,
  ampR: number,
): void {
  for (let i = 0; i < BLOCK; i++) {
    const n = n0 + i;
    const s =
      Math.sin((2 * Math.PI * 750 * n) / SR) * 0.7 +
      Math.sin((2 * Math.PI * 1123 * n) / SR) * 0.3;
    const click = n % 4801 < 24 ? 0.9 : 0;
    inL[i] = ampL * (s + click);
    inR[i] = ampR * (s - click);
  }
}

interface DigestOpts {
  mode: 'fet' | 'vca';
  params: Record<string, Float32Array>;
  blocks: number;
  ampL?: number;
  ampR?: number;
  /** Drive a 1-channel input, so `inR` falls back to `inL`. */
  mono?: boolean;
  /** Drive a 1-channel output, so the `outR` write is skipped. */
  monoOut?: boolean;
  /** Swap the k-rate params in at this block — the block-memo breaker. */
  paramsAfter?: Record<string, Float32Array>;
  switchAt?: number;
}

/**
 * Eight evenly-spaced samples of the final block per channel, plus a float64
 * sum over every sample of every block so a deviation anywhere in the run —
 * not just in the last one — moves the digest.
 */
function digest(opts: DigestOpts): number[] {
  const { mode, params, blocks, ampL = 1, ampR = 1 } = opts;
  const { mono = false, monoOut = false, paramsAfter, switchAt = -1 } = opts;
  const proc = new Processor({ processorOptions: { mode } });
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  let sumL = 0;
  let sumR = 0;
  let n = 0;
  let p = params;
  for (let b = 0; b < blocks; b++) {
    if (b === switchAt && paramsAfter) p = paramsAfter;
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    fillMusical(inL, inR, n, ampL, ampR);
    n += BLOCK;
    proc.process(mono ? [[inL]] : [[inL, inR]], monoOut ? [[outL]] : [[outL, outR]], p);
    for (let i = 0; i < BLOCK; i++) {
      sumL += outL[i]!;
      if (!monoOut) sumR += outR[i]!;
    }
  }
  const pick = (a: Float32Array): number[] => [0, 16, 32, 48, 64, 80, 96, 127].map((i) => a[i]!);
  return [
    ...pick(outL),
    ...(monoOut ? [] : pick(outR)),
    sumL,
    ...(monoOut ? [] : [sumR]),
  ];
}

/**
 * REQ-8 pin (`specs/features/runtime-performance.md`): a per-sample DSP speed
 * rewrite is **bit-exact or it is a sound change**. The tests above assert
 * physics with loose tolerances, which a rounding-level regression slips
 * straight through — these assert the samples themselves.
 *
 * The eight cases below cover every branch whose condition is fixed for a
 * block or an instance, because those are exactly what a hoisting optimisation
 * moves: both modes, `all` (ratio >= 100), the `blend` release paths (fet, and
 * vca with autoRelease), the mono-input and mono-output fallbacks, and a
 * mid-stream k-rate param change — the last is what a per-block constant memo
 * would break if it failed to notice the params moved.
 *
 * These numbers were captured from the implementation and are the contract.
 * If one fails, you changed what the compressor sounds like: that needs its own
 * spec and an ADR-010 justification, not a tolerance bump.
 *
 * The four `fet` cases were re-captured once, for compressor.md REQ-8 (priming
 * the DC blocker from its first sample). Only their **sums** moved, and only by
 * the start-up transient that change removes: the per-sample picks are identical
 * bar the last float32 bit, while e.g. "normal ratio" moved by ~285 ≈ the first
 * output sample times the blocker's 764-sample time constant. Measured on a
 * SILENT input the old code emitted a 0.02 step (≈ -34 dBFS) decaying over
 * ~16 ms and the new one emits exact zero — which is the whole point, and is
 * pinned independently by the case below so a future re-capture cannot quietly
 * lose it.
 *
 * Scope, stated precisely because it was measured rather than assumed: the
 * digest observes the **float32 output**, which is what is actually heard. It
 * catches any rewrite that moves an output sample — verified by mutation, e.g.
 * nudging the makeup smoothing from 10 ms to 10.0001 ms moves 3 of these 8
 * cases. It is deliberately insensitive to a float64 reassociation that never
 * survives the store into the output Float32Array (rewriting the DC blocker's
 * `y - x + r*yPrev` as `y + (r*yPrev - x)` moves nothing here, because the
 * filter is stable and the sub-ULP difference is ~9 orders below float32
 * resolution). That is the intended contract, not a gap: REQ-8 pins identical
 * *output*, and a difference that cannot reach the output cannot be heard.
 */
describe('hardware-compressor worklet is bit-exact (REQ-8)', () => {
  const CASES: Record<string, { opts: DigestOpts; frozen: number[] }> = {
    'vca, steady compression': {
      opts: {
        mode: 'vca',
        params: makeParams({ threshold: -20, ratio: 4, attack: 0.001, release: 0.3 }),
        blocks: 120,
      },
      frozen: [
        0.03789538890123367, 0.0676506906747818, 0.03329408913850784, -0.11474667489528656,
        -0.03858998417854309, 0.1692683845758438, -0.03275300934910774, 0.03193795308470726,
        0.03789538890123367, 0.0676506906747818, 0.03329408913850784, -0.11474667489528656,
        -0.03858998417854309, 0.1692683845758438, -0.03275300934910774, 0.03193795308470726,
        31.546358979981733, -20.028616097779604,
      ],
    },
    'vca, auto-release blend': {
      opts: {
        mode: 'vca',
        params: makeParams({
          threshold: -24, ratio: 10, attack: 0.001, release: 0.2, autoRelease: 1, makeup: 6,
        }),
        blocks: 120,
      },
      frozen: [
        0.038582880049943924, 0.0689711719751358, 0.0339960902929306, -0.11742349714040756,
        -0.03951350972056389, 0.17318861186504364, -0.03350794315338135, 0.03275515139102936,
        0.038582880049943924, 0.0689711719751358, 0.0339960902929306, -0.11742349714040756,
        -0.03951350972056389, 0.17318861186504364, -0.03350794315338135, 0.03275515139102936,
        28.752457996922317, -18.80983937382814,
      ],
    },
    'fet, all buttons in': {
      opts: {
        mode: 'fet',
        params: makeParams({
          threshold: -30, ratio: 100, attack: 0.0002, release: 0.1, makeup: 12,
        }),
        blocks: 120,
      },
      frozen: [
        0.08310951292514801, 0.12871679663658142, 0.07019069045782089, -0.19409936666488647,
        -0.07353351265192032, 0.21045339107513428, -0.06745371967554092, 0.07354477792978287,
        0.0860646590590477, 0.13161064684391022, 0.07302452623844147, -0.19132429361343384,
        -0.07081599533557892, 0.21311454474925995, -0.06484775990247726, 0.07604704797267914,
        -276.4357016346439, 286.1361829843954
      ],
    },
    'fet, normal ratio': {
      opts: {
        mode: 'fet',
        params: makeParams({
          threshold: -18, ratio: 4, attack: 0.0004, release: 0.3, makeup: 3,
        }),
        blocks: 120,
        ampL: 0.6,
        ampR: 0.5,
      },
      frozen: [
        0.08376414328813553, 0.14375047385692596, 0.06850366294384003, -0.2451440691947937,
        -0.08112690597772598, 0.33580783009529114, -0.07616735994815826, 0.07135052978992462,
        0.0749451071023941, 0.1252935826778412, 0.061967261135578156, -0.20159658789634705,
        -0.0630139410495758, 0.29149046540260315, -0.059158314019441605, 0.06376595795154572,
        -356.4031173734684, 304.2268429755786
      ],
    },
    'vca, mono input falls back to left': {
      opts: {
        mode: 'vca',
        params: makeParams({ threshold: -20, ratio: 8, attack: 0.002 }),
        blocks: 60,
        mono: true,
      },
      frozen: [
        -0.040928080677986145, 0.12040604650974274, 0.0179747324436903, -0.14517167210578918,
        0.04051044583320618, 0.08812196552753448, -0.018612569198012352, -0.047323912382125854,
        -0.040928080677986145, 0.12040604650974274, 0.0179747324436903, -0.14517167210578918,
        0.04051044583320618, 0.08812196552753448, -0.018612569198012352, -0.047323912382125854,
        26.62443232075418, 26.62443232075418,
      ],
    },
    'fet, mono output skips the right write': {
      opts: {
        mode: 'fet',
        params: makeParams({ threshold: -24, ratio: 20, attack: 0.0003, makeup: 6 }),
        blocks: 60,
        monoOut: true,
      },
      frozen: [
        -0.13394765555858612, 0.3635578751564026, 0.05974666029214859, -0.42545029520988464,
        0.14600709080696106, 0.2831231653690338, -0.06549319624900818, -0.1560482233762741,
        -477.57884619986726
      ],
    },
    'vca, k-rate params change mid-stream': {
      opts: {
        mode: 'vca',
        params: makeParams({ threshold: -20, ratio: 4, attack: 0.001, release: 0.3 }),
        paramsAfter: makeParams({
          threshold: -34, ratio: 20, attack: 0.02, release: 1.0, autoRelease: 1, makeup: 9,
        }),
        switchAt: 60,
        blocks: 120,
      },
      frozen: [
        0.025954285636544228, 0.046343278139829636, 0.022817200049757957, -0.0787312239408493,
        -0.02639773301780224, 0.1154840886592865, -0.022294770926237106, 0.02168518491089344,
        0.025954285636544228, 0.046343278139829636, 0.022817200049757957, -0.0787312239408493,
        -0.02639773301780224, 0.1154840886592865, -0.022294770926237106, 0.02168518491089344,
        30.541570253225245, -18.237173853421382,
      ],
    },
    'fet, k-rate params change mid-stream': {
      opts: {
        mode: 'fet',
        params: makeParams({ threshold: -20, ratio: 4, attack: 0.0002, release: 0.1 }),
        paramsAfter: makeParams({
          threshold: -36, ratio: 100, attack: 0.0008, release: 0.9, makeup: 15,
        }),
        switchAt: 60,
        blocks: 120,
      },
      frozen: [
        0.07910051941871643, 0.12114475667476654, 0.0665241926908493, -0.18084296584129333,
        -0.06825435906648636, 0.1937878131866455, -0.062206193804740906, 0.0687628760933876,
        0.08196422457695007, 0.1239490658044815, 0.06927033513784409, -0.17815376818180084,
        -0.06562093645334244, 0.19636662304401398, -0.059680867940187454, 0.07118771225214005,
        -480.2805663340878, 479.89261782201356
      ],
    },
  };

  for (const [name, { opts, frozen }] of Object.entries(CASES)) {
    it(`produces identical samples — ${name}`, () => {
      expect(digest(opts)).toEqual(frozen);
    });
  }
});

/**
 * compressor.md REQ-8 — silence in, silence out.
 *
 * The FET saturator is deliberately asymmetric (`tanh(d·(y + 0.02))/d`), so it
 * emits ≈ 0.02 for an input of ZERO. The 10 Hz DC blocker under it removes that
 * in steady state but used to start from zeroed state, so the first sample came
 * out as the whole pedestal — a -34 dBFS thump, ~16 ms long, every time the
 * processed path was first connected. That is once per page load, on whichever
 * demo or preset first switches the drum compressor on (song-mode.md REQ-17).
 *
 * A digest of a musical signal cannot see this: the transient is 8 orders below
 * the picks and only shows up in their sums, where it is indistinguishable from
 * any other change. Silence is the input that isolates it.
 */
describe('the FET path emits nothing for a silent input (REQ-8)', () => {
  const silentRun = (mode: 'fet' | 'vca', blocks = 40): { peak: number; first: number } => {
    const proc = new Processor({ processorOptions: { mode } });
    const params = makeParams();
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    let peak = 0;
    let first = 0;
    for (let b = 0; b < blocks; b++) {
      proc.process([[new Float32Array(BLOCK), new Float32Array(BLOCK)]], [[outL, outR]], params);
      if (b === 0) first = outL[0]!;
      for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(outL[i]!), Math.abs(outR[i]!));
    }
    return { peak, first };
  };

  it('fet: the first block is silent, not the saturator pedestal', () => {
    const { peak, first } = silentRun('fet');
    // Exactly zero, not merely small: the pedestal is differenced away rather
    // than filtered down, so there is nothing left to decay.
    expect(first).toBe(0);
    expect(peak).toBe(0);
  });

  it('vca: unaffected — it has no saturation to bias in the first place', () => {
    expect(silentRun('vca').peak).toBe(0);
  });
});
