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
