import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Drives the real `public/worklets/ladder-filter.js` processor under Node by
 * stubbing the AudioWorklet globals before importing it. Asserts physics
 * (boundedness, self-oscillation, low-level linearity), not golden samples.
 */

const SR = 48000;
const BLOCK = 128;

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
  const d: Record<string, number> = { cutoffNote: 90, resonance: 0, drive: 1, ...over };
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, new Float32Array([v])]));
}

/** Run `blocks` mono blocks through the processor; returns one flat Float32Array. */
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
function tailRms(a: Float32Array, frac = 0.25): number {
  const start = Math.floor(a.length * (1 - frac));
  let s = 0;
  for (let i = start; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / (a.length - start));
}

describe('ladder-filter worklet DSP', () => {
  it('stays finite and bounded under full-scale noise at max resonance', () => {
    const proc = new Processor();
    let seed = 1;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x3fffffff) - 1; // ~[-1, 1]
    };
    const out = run(proc, makeParams({ resonance: 4.2, drive: 2, cutoffNote: 84 }), noise, 200);
    expect(allFinite(out)).toBe(true);
    expect(peak(out)).toBeLessThan(24); // bounded — no runaway
  });

  it('self-oscillates: an impulse rings far longer at high resonance', () => {
    const impulse = (n: number) => (n === 0 ? 1 : 0);
    const params = (res: number) => makeParams({ resonance: res, cutoffNote: 72 });

    const hi = run(new Processor(), params(4.2), impulse, 120);
    const lo = run(new Processor(), params(0), impulse, 120);

    expect(allFinite(hi)).toBe(true);
    expect(peak(hi)).toBeLessThan(24); // bounded, self-limiting
    // Resonance keeps energy alive long after the low-res impulse has decayed.
    expect(tailRms(hi)).toBeGreaterThan(tailRms(lo) * 10);
  });

  it('matches a linear ladder reference at low level / zero resonance', () => {
    // sat'(0) === 1, so small signals through the saturated filter track a
    // plain linear one-pole cascade — existing presets are preserved.
    const cutoffNote = 100;
    const drive = 1;
    const amp = 0.01;
    const sine = (n: number) => amp * Math.sin((2 * Math.PI * 300 * n) / SR);

    const got = run(new Processor(), makeParams({ resonance: 0, drive, cutoffNote }), sine, 80);

    // Reference: same g, linear stages, no saturation.
    const freq = 440 * Math.pow(2, (cutoffNote - 69) / 12);
    const fNorm = Math.min(Math.max(freq / SR, 0.0001), 0.49);
    const g = 1 - Math.exp(-2 * Math.PI * fNorm);
    const ref = new Float32Array(got.length);
    const s = [0, 0, 0, 0];
    for (let n = 0; n < ref.length; n++) {
      const v = sine(n) * drive;
      s[0]! += g * (v - s[0]!);
      s[1]! += g * (s[0]! - s[1]!);
      s[2]! += g * (s[1]! - s[2]!);
      s[3]! += g * (s[2]! - s[3]!);
      ref[n] = s[3]!;
    }

    // Compare the settled tail (skip the startup transient).
    const start = ref.length - BLOCK;
    let maxDiff = 0;
    let peakRef = 0;
    for (let i = start; i < ref.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(got[i]! - ref[i]!));
      peakRef = Math.max(peakRef, Math.abs(ref[i]!));
    }
    expect(maxDiff / peakRef).toBeLessThan(0.05);
  });

  it('low-passes: attenuates content well above the cutoff', () => {
    const proc = new Processor();
    // Cutoff note 48 ≈ 130 Hz; a 6 kHz tone should be heavily attenuated.
    const tone = (n: number) => 0.5 * Math.sin((2 * Math.PI * 6000 * n) / SR);
    const out = run(proc, makeParams({ resonance: 0, cutoffNote: 48 }), tone, 60);
    expect(peak(out)).toBeLessThan(0.1); // << 0.5 input peak
  });

  it('idle gating: silence while inactive, clean (fresh-equal) restart (REQ-10)', () => {
    const gen = (n: number) => 0.5 * Math.sin((2 * Math.PI * 220 * n) / SR);
    const params = makeParams({ resonance: 1, cutoffNote: 80 });

    const proc = new Processor();
    const before = run(proc, params, gen, 10);
    expect(peak(before)).toBeGreaterThan(0); // active by default

    proc.port.onmessage!({ data: false });
    const silent = run(proc, params, gen, 10);
    expect(peak(silent)).toBe(0); // hot input, zero output — DSP skipped

    proc.port.onmessage!({ data: true });
    const after = run(proc, params, gen, 10);
    // Deactivation zeroed the state, so reactivation matches a fresh filter
    // bit-for-bit on the same input.
    const fresh = run(new Processor(), params, gen, 10);
    expect(after).toEqual(fresh);
    expect(allFinite(after)).toBe(true);
  });

  // REQ-11: env + LFO are always connected to cutoffNote, so the host hands a
  // full 128-length array. When it is all-equal, the coefficient is hoisted
  // once per block (cached across blocks) — must be bit-identical to feeding a
  // length-1 array, and the cache must invalidate when the value changes.
  const mkParams = (cutoff: Float32Array, res: number): Record<string, Float32Array> => ({
    cutoffNote: cutoff,
    resonance: new Float32Array([res]),
    drive: new Float32Array([1]),
  });

  it('hoists a block-constant cutoff bit-identically to a length-1 array (REQ-11)', () => {
    const gen = (n: number) => 0.3 * Math.sin((2 * Math.PI * 300 * n) / SR);
    const procFull = new Processor();
    const procOne = new Processor();

    const full = run(procFull, mkParams(new Float32Array(BLOCK).fill(90), 1), gen, 10);
    const one = run(procOne, mkParams(new Float32Array([90]), 1), gen, 10);
    expect(full).toEqual(one);

    // Change the constant cutoff → the per-block cache must recompute; the two
    // array shapes must still agree sample-for-sample on the following blocks.
    const full60 = run(procFull, mkParams(new Float32Array(BLOCK).fill(60), 1), gen, 10);
    const one60 = run(procOne, mkParams(new Float32Array([60]), 1), gen, 10);
    expect(full60).toEqual(one60);
  });

  it('keeps a varying cutoff block per-sample accurate — the hoist does not fire (REQ-11)', () => {
    const tone = (n: number) => 0.5 * Math.sin((2 * Math.PI * 6000 * n) / SR);
    // Low cutoff for the first half of each block, high for the second half.
    const varying = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) varying[i] = i < BLOCK / 2 ? 36 : 120;

    const out = run(new Processor(), mkParams(varying, 0), tone, 8);
    const low = run(new Processor(), mkParams(new Float32Array([36]), 0), tone, 8);

    // Opening to note 120 for half of every block passes 6 kHz energy the
    // all-note-36 (heavily low-passed) run cannot. If the hoist wrongly fired it
    // would use cutoffArr[0]=36 for the whole block and the peaks would match.
    expect(peak(out)).toBeGreaterThan(peak(low) * 3);
  });
});
