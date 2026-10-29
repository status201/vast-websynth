import { describe, it, expect, beforeAll, vi } from 'vitest';
import { REVERSE_MAX_TIME_S, REVERSE_MIN_TIME_S } from '../../src/audio/effects/delay-cores';

/**
 * Drives the real `public/worklets/reverse-delay.js` processor under Node by
 * stubbing the AudioWorklet globals before importing it, like
 * flanger-worklet.test.ts (delay-types.md REQ-each-type-has-its-own-topology,
 * REQ-every-type-is-bounded). The sound itself is signed off by ear (ADR-010).
 */

const SR = 48000;
const BLOCK = 128;

interface ProcessorLike {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}

let Processor: new () => ProcessorLike;
let descriptors: Array<{ name: string; minValue: number; maxValue: number }>;

beforeAll(async () => {
  vi.stubGlobal('sampleRate', SR);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage: vi.fn(), onmessage: null }; });
  vi.stubGlobal('registerProcessor', (_name: string, cls: unknown) => {
    Processor = cls as typeof Processor;
    descriptors = (cls as { parameterDescriptors: typeof descriptors }).parameterDescriptors;
  });
  await import('../../public/worklets/reverse-delay.js' as string);
});

const params = (p: { time?: number; feedback?: number; char?: number }): Record<string, Float32Array> => ({
  time: new Float32Array([p.time ?? 0.1]),
  feedback: new Float32Array([p.feedback ?? 0]),
  char: new Float32Array([p.char ?? 0.5]),
});

/** Run `blocks` mono blocks of `src(n)`; returns every output sample. */
function run(proc: ProcessorLike, p: Record<string, Float32Array>, blocks: number, src: (n: number) => number): Float32Array {
  const all = new Float32Array(blocks * BLOCK);
  for (let b = 0; b < blocks; b++) {
    const inp = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) inp[i] = src(b * BLOCK + i);
    const out = new Float32Array(BLOCK);
    proc.process([[inp]], [[out]], p);
    all.set(out, b * BLOCK);
  }
  return all;
}

describe('reverse-delay worklet', () => {
  it('mirrors its time range in the main-thread constants', () => {
    const time = descriptors.find((d) => d.name === 'time')!;
    expect(time.minValue).toBe(REVERSE_MIN_TIME_S);
    expect(time.maxValue).toBe(REVERSE_MAX_TIME_S);
    expect(descriptors.find((d) => d.name === 'feedback')!.maxValue).toBe(0.95);
  });

  it('plays an impulse back within the following two windows, once at feedback 0', () => {
    const len = 0.1 * SR;
    const out = run(new Processor(), params({ time: 0.1 }), Math.ceil((4 * len) / BLOCK), (n) => (n === 0 ? 1 : 0));
    const hits = [...out.keys()].filter((i) => Math.abs(out[i]!) > 1e-6);
    expect(hits.length).toBeGreaterThan(0);
    expect(Math.max(...hits)).toBeLessThan(2 * len);
    // The window sum is 1, so the impulse comes back at no more than unity.
    expect(Math.max(...hits.map((i) => Math.abs(out[i]!)))).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('turns a rising ramp into a falling one', () => {
    const len = 0.1 * SR;
    const out = run(new Processor(), params({ time: 0.1, char: 0 }), Math.ceil((3 * len) / BLOCK), (n) => n / (4 * len));
    // Mid-window of the second head, away from the crossovers: the output falls.
    const a = Math.round(1.5 * len);
    expect(out[a + 100]!).toBeLessThan(out[a]!);
  });

  it('stays finite and bounded at feedback 0.95 under full-scale noise and NaN', () => {
    const proc = new Processor();
    let seed = 1;
    const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };
    const out = run(proc, params({ time: 0.05, feedback: 0.95, char: 1 }), Math.ceil((20 * SR) / BLOCK), (n) =>
      n % 9973 === 0 ? NaN : noise());
    let peak = 0;
    let finite = true;
    for (const y of out) {
      if (!Number.isFinite(y)) finite = false;
      else if (Math.abs(y) > peak) peak = Math.abs(y);
    }
    expect(finite).toBe(true);
    expect(peak).toBeLessThan(4);
  });

  it('reads a disconnected input as silence, so a drain empties it', () => {
    const proc = new Processor();
    run(proc, params({ time: 0.1 }), 40, () => 0.5);
    const out = new Float32Array(BLOCK);
    for (let b = 0; b < Math.ceil((2 * 0.1 * SR) / BLOCK) + 2; b++) proc.process([[]], [[out]], params({ time: 0.1 }));
    proc.process([[]], [[out]], params({ time: 0.1 }));
    expect(Math.max(...out.map(Math.abs))).toBe(0);
  });
});
