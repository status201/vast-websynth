import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadWorklet } from '../worklet-harness';

/**
 * Drives the real `public/worklets/limiter.js` under Node
 * (specs/features/master-limiter.md). Every render is folded to a handful of
 * numbers and asserted once — never an `expect` per sample.
 */

const SR = 48000;
const BLOCK = 128;
const L = Math.round(0.0015 * SR); // the lookahead, as the worklet computes it

interface ProcessorLike {
  port: { postMessage: ReturnType<typeof vi.fn> };
  fast: number;
  slow: number;
  boxSum: number;
  len: number;
  backstopHits: number;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
}

let Processor: new () => ProcessorLike;

beforeAll(async () => {
  Processor = await loadWorklet<typeof Processor>('limiter', { sampleRate: SR });
});

const dbToLin = (db: number): number => Math.pow(10, db / 20);

function params(drive = 0, ceiling = 0): Record<string, Float32Array> {
  return { drive: new Float32Array([drive]), ceiling: new Float32Array([ceiling]) };
}

/** Run whole signals through in blocks; returns the two output channels. */
function render(
  proc: ProcessorLike,
  inL: Float32Array,
  inR: Float32Array,
  p: Record<string, Float32Array> = params(),
): { outL: Float32Array; outR: Float32Array } {
  const outL = new Float32Array(inL.length);
  const outR = new Float32Array(inL.length);
  for (let o = 0; o < inL.length; o += BLOCK) {
    const bl = new Float32Array(BLOCK);
    const br = new Float32Array(BLOCK);
    bl.set(inL.subarray(o, o + BLOCK));
    br.set(inR.subarray(o, o + BLOCK));
    const ol = new Float32Array(BLOCK);
    const or = new Float32Array(BLOCK);
    proc.process([[bl, br]], [[ol, or]], p);
    outL.set(ol.subarray(0, Math.min(BLOCK, inL.length - o)), o);
    outR.set(or.subarray(0, Math.min(BLOCK, inL.length - o)), o);
  }
  return { outL, outR };
}

/** Deterministic noise in [-amp, amp]. */
function noise(n: number, amp: number, seed = 1): Float32Array {
  const a = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    a[i] = ((s / 4294967296) * 2 - 1) * amp;
  }
  return a;
}

function fill(n: number, f: (i: number) => number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = f(i);
  return a;
}

/** Gain applied to sample n: out[n] / in[n − L] (inputs must be non-zero there). */
function gains(out: Float32Array, input: Float32Array): Float64Array {
  const g = new Float64Array(out.length);
  for (let n = L; n < out.length; n++) g[n] = out[n]! / input[n - L]!;
  return g;
}

describe('master limiter worklet', () => {
  it('passes in-range audio bit-exact, L samples late (REQ-in-range-audio-passes-unchanged)', () => {
    const proc = new Processor();
    const n = SR;
    const inL = noise(n, 0.99, 7);
    const inR = noise(n, 0.99, 11);
    inL[5000] = 1; inR[9000] = -1; // exactly full scale is still in range
    const { outL, outR } = render(proc, inL, inR);
    let mismatches = 0;
    for (let i = 0; i < n; i++) {
      const eL = i < L ? 0 : inL[i - L]!;
      const eR = i < L ? 0 : inR[i - L]!;
      if (outL[i] !== eL || outR[i] !== eR) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(proc.fast).toBe(1);
  });

  it('keeps every sample within ±ceiling, with no backstop hit (REQ-the-output-never-exceeds-the-ceiling)', () => {
    const n = SR / 2;
    const signals: Record<string, () => [Float32Array, Float32Array]> = {
      square: () => { const s = fill(n, (i) => ((i >> 6) & 1 ? 1 : -1)); return [s, s]; },
      impulse: () => [fill(n, (i) => (i === 10_000 ? 8 : 0)), new Float32Array(n)],
      burst40dB: () => {
        const s = fill(n, (i) => (i > 8000 && i < 12_000 ? 100 * Math.sin(i * 0.05) : 0.2 * Math.sin(i * 0.05)));
        return [s, s];
      },
      noise: () => [noise(n, 3, 3), noise(n, 3, 5)],
    };
    const worst: string[] = [];
    let hits = 0;
    for (const ceiling of [0, -6]) {
      for (const drive of [0, 12]) {
        for (const [name, make] of Object.entries(signals)) {
          const proc = new Processor();
          const [inL, inR] = make();
          const { outL, outR } = render(proc, inL, inR, params(drive, ceiling));
          let peak = 0;
          let finite = true;
          for (let i = 0; i < n; i++) {
            const a = Math.max(Math.abs(outL[i]!), Math.abs(outR[i]!));
            if (!Number.isFinite(a)) finite = false;
            if (a > peak) peak = a;
          }
          // Float32 storage can round the ceiling itself up by half an ULP.
          if (!finite || peak > dbToLin(ceiling) * (1 + 1e-7)) worst.push(`${name} d${drive} c${ceiling}: ${peak}`);
          hits += proc.backstopHits;
        }
      }
    }
    expect(worst).toEqual([]);
    expect(hits).toBe(0);
  });

  it('ramps the gain down across the lookahead (REQ-the-attack-is-a-ramp-not-a-step)', () => {
    const proc = new Processor();
    const n = 4096;
    const k = 2000; // the over, on a 0.5 carrier so the gain is readable everywhere
    const inL = fill(n, (i) => (i === k ? 4 : 0.5));
    const { outL } = render(proc, inL, inL);
    const g = gains(outL, inL);
    const target = 1 / 4;
    // The over leaves the delay line at k + L, with a gain at or under its target.
    // Gains are read off float32 output, so they carry ~1e-7 of rounding.
    expect(g[k + L]!).toBeLessThanOrEqual(target + 1e-6);
    let rising = 0;
    let maxStep = 0;
    for (let i = k; i <= k + L; i++) {
      if (g[i]! > g[i - 1]! + 1e-6) rising++;
      maxStep = Math.max(maxStep, g[i - 1]! - g[i]!);
    }
    expect(rising).toBe(0);
    expect(maxStep).toBeLessThanOrEqual((1 - target) / (L + 1) + 1e-6);
    // Before the ramp starts the carrier was untouched.
    expect(g[k - 1]!).toBe(1);
  });

  it('recovers from a transient faster than from a sustained overload (REQ-release-follows-the-program)', () => {
    const recovery = (burstLen: number): number => {
      const proc = new Processor();
      const start = 4800;
      const n = start + burstLen + SR * 4;
      const inL = fill(n, (i) => (i >= start && i < start + burstLen ? 4 : 0.5));
      const { outL } = render(proc, inL, inL);
      const g = gains(outL, inL);
      const within1dB = dbToLin(-1);
      const end = start + burstLen + L;
      for (let i = end; i < n; i++) if (g[i]! >= within1dB) return (i - end) / SR;
      return Infinity;
    };
    const transient = recovery(96); // 2 ms
    const sustained = recovery(SR); // 1 s
    expect(transient).toBeLessThan(0.15);
    expect(sustained).toBeGreaterThan(transient * 3);
    expect(Number.isFinite(sustained)).toBe(true);
  });

  it('applies one gain to both channels (REQ-stereo-is-linked)', () => {
    const proc = new Processor();
    const n = 8192;
    const inL = fill(n, (i) => (i % 1500 === 700 ? 3 : 0.5));
    const inR = fill(n, () => 0.3);
    const { outL, outR } = render(proc, inL, inR);
    const gL = gains(outL, inL);
    const gR = gains(outR, inR);
    let maxDiff = 0;
    let minGain = 1;
    for (let i = L; i < n; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(gL[i]! - gR[i]!));
      minGain = Math.min(minGain, gR[i]!);
    }
    expect(minGain).toBeLessThan(0.5); // the right channel was reduced by the left's peak
    expect(maxDiff).toBeLessThan(1e-6); // float32 output rounding, not two gains
  });

  it('turns silence into exact silence, and comes to rest at exactly 1 (REQ-silence-in-is-silence-out)', () => {
    const proc = new Processor();
    const loud = fill(SR / 2, () => 4);
    render(proc, loud, loud);
    expect(proc.slow).toBeLessThan(0.9);
    const quiet = new Float32Array(SR * 12);
    const { outL, outR } = render(proc, quiet, quiet);
    let nonZero = 0;
    for (let i = L; i < quiet.length; i++) if (outL[i] !== 0 || outR[i] !== 0) nonZero++;
    expect(nonZero).toBe(0);
    expect(proc.fast).toBe(1);
    expect(proc.slow).toBe(1);
    expect(proc.boxSum).toBe(proc.len);
  });

  it('reads NaN and Infinity as silence and stays clean after (REQ-non-finite-input-never-reaches-state)', () => {
    const proc = new Processor();
    const bad = fill(BLOCK, (i) => [NaN, Infinity, -Infinity, 0.5][i % 4]!);
    const { outL: o1 } = render(proc, bad, bad);
    const good = noise(BLOCK * 8, 0.9, 13);
    const { outL: o2, outR: o2r } = render(proc, good, good);
    let nonFinite = 0;
    for (const v of [...o1, ...o2, ...o2r]) if (!Number.isFinite(v)) nonFinite++;
    expect(nonFinite).toBe(0);
    let mismatches = 0;
    for (let i = L; i < good.length; i++) if (o2[i] !== good[i - L]) mismatches++;
    expect(mismatches).toBe(0);
  });

  it('meters reduction while limiting and stays quiet at rest (REQ-the-limiter-posts-gain-reduction)', () => {
    const proc = new Processor();
    const tone = fill(SR, (i) => 0.5 * Math.sin(i * 0.03));
    render(proc, tone, tone);
    expect(proc.port.postMessage).not.toHaveBeenCalled();

    const over = fill(SR / 2, (i) => 3 * Math.sin(i * 0.03));
    render(proc, over, over);
    const during = proc.port.postMessage.mock.calls.map((c) => c[0] as number);
    expect(Math.max(...during)).toBeGreaterThan(6);

    const after = fill(SR * 15, (i) => 0.5 * Math.sin(i * 0.03));
    render(proc, after, after);
    const calls = proc.port.postMessage.mock.calls.map((c) => c[0] as number);
    expect(calls[calls.length - 1]!).toBeLessThanOrEqual(0.01);
    proc.port.postMessage.mockClear();
    render(proc, tone, tone);
    expect(proc.port.postMessage).not.toHaveBeenCalled();
  });
});
