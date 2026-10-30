import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  FLANGER_MIN_DELAY_S, FLANGER_SPAN_OCTAVES, FLANGER_MAX_FEEDBACK,
} from '../../src/audio/effects/flanger-live';

/**
 * Drives the real `public/worklets/flanger.js` processor under Node by stubbing
 * the AudioWorklet globals before importing it, like compressor-worklet.test.ts
 * (flanger.md). These pin the stability contract and the sweep's range; the
 * sound itself is signed off by ear (ADR-010).
 */

const SR = 48000;
const BLOCK = 128;

interface ProcessorLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
}

let Processor: new () => ProcessorLike;
let descriptors: Array<{ name: string; maxValue: number }>;

beforeAll(async () => {
  vi.stubGlobal('sampleRate', SR);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage: vi.fn(), onmessage: null }; });
  vi.stubGlobal('registerProcessor', (_name: string, cls: unknown) => {
    Processor = cls as typeof Processor;
    descriptors = (cls as { parameterDescriptors: typeof descriptors }).parameterDescriptors;
  });
  await import('../../public/worklets/flanger.js' as string);
});

const params = (p: { rate?: number; depth?: number; feedback?: number }): Record<string, Float32Array> => ({
  rate: new Float32Array([p.rate ?? 0.2]),
  depth: new Float32Array([p.depth ?? 0.7]),
  feedback: new Float32Array([p.feedback ?? 0]),
});

/** Run `blocks` mono blocks, each filled by `src(n)` for the absolute sample index; returns every output sample. */
function run(
  proc: ProcessorLike,
  p: Record<string, Float32Array>,
  blocks: number,
  src: (n: number) => number,
  start = 0,
): Float32Array {
  const all = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b++) {
    const inp = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) inp[i] = src(start + b * BLOCK + i);
    const out = new Float32Array(BLOCK);
    proc.process([[inp]], [[out]], p);
    all.set(out, b * BLOCK);
  }
  return all;
}

/** A deterministic full-scale noise source (LCG), so a failure reproduces. */
function noise(seed = 1): (n: number) => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

describe('flanger worklet: bounded (flanger.md REQ-the-flanger-feedback-is-bounded)', () => {
  it('clamps the feedback param to FLANGER_MAX_FEEDBACK', () => {
    expect(descriptors.find((d) => d.name === 'feedback')!.maxValue).toBe(FLANGER_MAX_FEEDBACK);
  });

  it('stays finite and under a fixed bound at the extremes, even with an out-of-range feedback', () => {
    const proc = new Processor();
    const p = params({ rate: 5, depth: 1, feedback: 5 });
    // Half a second each: the longest loop is ~5.7 ms, so a resonance is long settled.
    const blocks = Math.ceil((0.5 * SR) / BLOCK);
    const outs = [
      run(proc, p, blocks, noise(7)),
      run(proc, p, blocks, (n) => ((n >> 6) & 1 ? 1 : -1)), // a 0 dBFS square
      run(proc, p, blocks, () => 0),
    ];
    // Folded, then asserted once per take: 2 expects per sample (~144k) timed out
    // under a full parallel run.
    for (const out of outs) {
      let finite = true;
      let peak = 0;
      for (const v of out) {
        if (!Number.isFinite(v)) finite = false;
        peak = Math.max(peak, Math.abs(v));
      }
      expect(finite).toBe(true);
      // |written| <= |x| + 0.9 and the read interpolates between two of them.
      expect(peak).toBeLessThan(2);
    }
  });

  it('empties to exact silence once the input stops, at feedback 0', () => {
    const proc = new Processor();
    const p = params({ rate: 1, depth: 1, feedback: 0 });
    run(proc, p, 200, noise(3));
    const maxDelay = FLANGER_MIN_DELAY_S * 2 ** FLANGER_SPAN_OCTAVES * SR;
    const tail = run(proc, p, 20, () => 0);
    // After the longest delay plus the interpolation tap, every read is of silence.
    const settled = tail.subarray(Math.ceil(maxDelay) + 2);
    expect(settled.every((v) => v === 0)).toBe(true);
  });

  it('reads a disconnected input as silence and keeps draining', () => {
    const proc = new Processor();
    const p = params({ depth: 1, feedback: 0 });
    run(proc, p, 50, noise(5));
    let last = new Float32Array(BLOCK);
    for (let b = 0; b < 10; b++) {
      last = new Float32Array(BLOCK);
      proc.process([[]], [[last]], p);
    }
    expect(last.every((v) => v === 0)).toBe(true);
  });

  it('does not let NaN or Infinity into the loop', () => {
    const proc = new Processor();
    const p = params({ depth: 1, feedback: 0.9 });
    const sine = (n: number): number => Math.sin((2 * Math.PI * 220 * n) / SR);
    run(proc, p, 40, sine);
    run(proc, p, 1, (n) => (n % 3 === 0 ? NaN : n % 3 === 1 ? Infinity : -Infinity), 40 * BLOCK);
    const after = run(proc, p, 100, sine, 41 * BLOCK);
    expect(after.every((v) => Number.isFinite(v))).toBe(true);
    expect(after.some((v) => v !== 0)).toBe(true);
  });
});

describe('flanger worklet: the sweep (flanger.md REQ-the-flanger-sweeps-in-pitch)', () => {
  /** Where an impulse fed now comes out, in samples after it went in (fb 0). */
  function impulseDelay(proc: ProcessorLike, p: Record<string, Float32Array>): number {
    const out = run(proc, p, 4, (n) => (n === 0 ? 1 : 0));
    let at = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]!) > Math.abs(out[at]!)) at = i;
    // The interpolated pair around the peak gives the fractional delay.
    const a = Math.abs(out[at]!);
    const b = Math.abs(out[at + 1]!);
    const c = Math.abs(out[at - 1]!);
    return b > c ? at + b / (a + b) : at - c / (a + c);
  }

  it('holds at FLANGER_MIN_DELAY_S at depth 0', () => {
    const proc = new Processor();
    expect(impulseDelay(proc, params({ depth: 0 }))).toBeCloseTo(FLANGER_MIN_DELAY_S * SR, 1);
  });

  it('reaches FLANGER_MIN_DELAY_S * 2^FLANGER_SPAN_OCTAVES at the top of the LFO, at depth 1', () => {
    const proc = new Processor();
    // A slow rate, so the delay barely moves (~0.5 sample) while the impulse
    // is in flight; its peak (phase 0.5) is 10 s in.
    const p = params({ rate: 0.05, depth: 1 });
    const toPeak = Math.round(0.5 / (0.05 / SR)) - 270;
    const blocks = Math.floor(toPeak / BLOCK);
    run(proc, p, blocks, () => 0);
    const expected = FLANGER_MIN_DELAY_S * 2 ** FLANGER_SPAN_OCTAVES * SR;
    expect(Math.abs(impulseDelay(proc, p) - expected)).toBeLessThan(1.5);
  });
});

describe('flanger worklet: channels (flanger.md REQ-the-flanger-is-a-worklet-delay-line)', () => {
  it('fills one output channel for a mono input and two for a stereo one, each from its own buffer', () => {
    const proc = new Processor();
    const p = params({ depth: 0 });
    const mono = new Float32Array(BLOCK);
    const inMono = new Float32Array(BLOCK);
    inMono[0] = 1;
    proc.process([[inMono]], [[mono]], p);
    expect(mono.some((v) => v !== 0)).toBe(true);

    const proc2 = new Processor();
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inL = new Float32Array(BLOCK);
    inL[0] = 1;
    proc2.process([[inL, new Float32Array(BLOCK)]], [[outL, outR]], p);
    expect(outL.some((v) => v !== 0)).toBe(true);
    expect(outR.every((v) => v === 0)).toBe(true);
  });
});
