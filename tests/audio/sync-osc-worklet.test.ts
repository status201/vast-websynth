import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Drives the real `public/worklets/sync-osc.js` processor under Node by stubbing
 * the AudioWorklet globals before importing it — the harness of
 * `ladder-filter-worklet.test.ts`. specs/features/oscillator-sync.md.
 *
 * Asserts behaviour (locking, continuity, boundedness) and one objective quality
 * measure, aliasing, never golden samples. The alias metric works because a
 * hard-synced wave is exactly periodic at the master's frequency: give the
 * master a period of a half-integer number of samples and every folded partial
 * lands *between* two harmonics, so the DFT bins between them read aliasing
 * directly. How it *sounds* is still a listening job (ADR-010).
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
interface Descriptor { name: string; defaultValue: number }

let Processor: (new (opts?: unknown) => ProcessorLike) & { parameterDescriptors: Descriptor[] };

beforeAll(async () => {
  vi.stubGlobal('sampleRate', SR);
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: null, postMessage: () => {} };
  });
  vi.stubGlobal('registerProcessor', (_name: string, cls: unknown) => {
    Processor = cls as typeof Processor;
  });
  await import('../../public/worklets/sync-osc.js' as string);
});

const HARD = 1;
const SOFT = 2;
const SINE = 0, TRI = 1, SAW = 2, SQUARE = 3;

function params(over: Record<string, number | Float32Array> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const d of Processor.parameterDescriptors) {
    const v = over[d.name] ?? d.defaultValue;
    out[d.name] = v instanceof Float32Array ? v : new Float32Array([v]);
  }
  return out;
}

/** Render `samples` of both outputs. `kernel` / `half` are the processor's measurement hooks. */
function render(
  over: Record<string, number | Float32Array>,
  samples: number,
  processorOptions: Record<string, unknown> = {},
): { master: Float32Array; slave: Float32Array; proc: ProcessorLike } {
  const proc = new Processor({ processorOptions });
  const p = params(over);
  const master = new Float32Array(Math.ceil(samples / BLOCK) * BLOCK);
  const slave = new Float32Array(master.length);
  for (let off = 0; off < master.length; off += BLOCK) {
    const a = new Float32Array(BLOCK), b = new Float32Array(BLOCK);
    proc.process([], [[a], [b]], p);
    master.set(a, off);
    slave.set(b, off);
  }
  return { master, slave, proc };
}

const semis = (ratio: number) => 12 * Math.log2(ratio);

/**
 * Alias energy relative to harmonic energy, in dB. `G` is the grid — twice the
 * output period in samples, an odd integer — so even bins are harmonics and odd
 * bins aliases. Only bins up to `maxHz` count as aliases.
 */
function aliasDb(x: Float32Array, G: number, skip: number, periods: number, maxHz = SR / 2): number {
  let harm = 0, alias = 0;
  const N = G * periods;
  for (let j = 1; j <= (G - 1) / 2; j++) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * j) / G;
    for (let n = 0; n < N; n++) {
      const v = x[skip + n]!;
      re += v * Math.cos(w * n);
      im -= v * Math.sin(w * n);
    }
    const e = re * re + im * im;
    if (j % 2 === 0) harm += e;
    else if ((j * SR) / G <= maxHz) alias += e;
  }
  return 10 * Math.log10(alias / harm + 1e-30);
}

describe('hard sync locks the slave to the master (REQ-sync-has-hard-and-soft-modes)', () => {
  it('repeats with the master period at a non-integer ratio', () => {
    // A 64-sample master period, so the locked output repeats exactly every 64.
    const { slave } = render({ frequency: SR / 64, syncPitch: semis(2.7), mode: HARD, wave2: SAW }, 8192);
    let worst = 0;
    for (let n = 4096; n < 8000; n++) worst = Math.max(worst, Math.abs(slave[n]! - slave[n - 64]!));
    expect(worst).toBeLessThan(1e-3);
  });

  it('does not repeat with the master period when free-running', () => {
    const { slave } = render({ frequency: SR / 64, syncPitch: semis(2.7), mode: 0, wave2: SAW }, 8192);
    let worst = 0;
    for (let n = 4096; n < 8000; n++) worst = Math.max(worst, Math.abs(slave[n]! - slave[n - 64]!));
    expect(worst).toBeGreaterThan(0.1);
  });
});

describe('soft sync keeps the slave continuous (REQ-sync-has-hard-and-soft-modes)', () => {
  const f0 = 500;
  const ratio = 2.7;
  // A triangle moves 4 units per cycle each way, so its natural per-sample step is 4·inc.
  const slopeBound = 4 * ((f0 * ratio) / SR) * 1.5;
  const maxStep = (mode: number) => {
    const { slave } = render({ frequency: f0, syncPitch: semis(ratio), mode, wave2: TRI }, 16384);
    let m = 0;
    for (let n = 2048; n < slave.length; n++) m = Math.max(m, Math.abs(slave[n]! - slave[n - 1]!));
    return m;
  };

  it('never steps faster than the triangle itself does', () => {
    expect(maxStep(SOFT)).toBeLessThan(slopeBound);
  });

  it('is told apart from hard sync, which does jump', () => {
    expect(maxStep(HARD)).toBeGreaterThan(slopeBound * 2);
  });
});

describe('aliasing (REQ-every-discontinuity-is-band-limited)', () => {
  // Master periods of a half-integer number of samples: 130 Hz, 744 Hz, 2.9 kHz.
  const cases = [369.5, 64.5, 16.5].flatMap((P) => [1.5, 4.3, 7.9].map((r) => ({ P, r })));

  const measure = (P: number, r: number, wave: number, opts: Record<string, unknown>, maxHz?: number) => {
    const G = Math.round(2 * P);
    const { slave } = render({ frequency: SR / P, syncPitch: semis(r), mode: HARD, wave2: wave }, G * 12 + 4096, opts);
    return aliasDb(slave, G, 4096, 8, maxHz);
  };

  for (const { P, r } of cases) {
    const f0 = Math.round(SR / P);
    it(`saw slave at ${f0} Hz × ${r} is at the floor below 10 kHz`, () => {
      expect(measure(P, r, SAW, {}, 10000)).toBeLessThan(-60);
    });

    it(`saw slave at ${f0} Hz × ${r} beats polyBLEP and a naive reset by 15 dB`, () => {
      const shipped = measure(P, r, SAW, {});
      expect(shipped).toBeLessThan(measure(P, r, SAW, { kernel: 'poly' }) - 15);
      expect(shipped).toBeLessThan(measure(P, r, SAW, { kernel: 'naive' }) - 15);
    });
  }

  it('band-limits the square and triangle slaves too', () => {
    for (const wave of [TRI, SQUARE]) {
      expect(measure(64.5, 4.3, wave, {}, 10000), `wave ${wave}`).toBeLessThan(-60);
    }
  });
});

describe('the slave is DC-free (REQ-the-slave-is-dc-free)', () => {
  it('removes the mean a truncated saw carries', () => {
    // Ratio 1.5: one full ramp plus half of one per master cycle — a clear offset raw.
    const { slave } = render({ frequency: 220, syncPitch: semis(1.5), mode: HARD, wave2: SAW }, SR * 2);
    const tail = slave.subarray(SR, SR * 2);
    const mean = tail.reduce((s, v) => s + v, 0) / tail.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
  });

  it('centres a narrow pulse on the master as well', () => {
    const { master } = render({ frequency: 220, wave1: SQUARE, width1: 0.9, mode: HARD }, SR);
    const tail = master.subarray(SR / 2, SR);
    const mean = tail.reduce((s, v) => s + v, 0) / tail.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
  });
});

describe('the pair owns both phases (REQ-the-pair-owns-both-phases)', () => {
  it('at ratio 1 the slave is the master, not a phase-shifted copy', () => {
    const { master, slave } = render({ frequency: 220, syncPitch: 0, mode: HARD, wave1: SAW, wave2: SAW }, SR);
    let xy = 0, xx = 0, yy = 0;
    for (let n = SR / 2; n < SR; n++) {
      xy += master[n]! * slave[n]!;
      xx += master[n]! * master[n]!;
      yy += slave[n]! * slave[n]!;
    }
    expect(xy / Math.sqrt(xx * yy)).toBeGreaterThan(0.99);
  });
});

describe('the pair is bounded for any input (REQ-the-pair-is-bounded)', () => {
  const hostile = [NaN, Infinity, -Infinity, 0, -1, 1e9, -1e9, 1e-30];
  /** The worst sample, NaN-aware: one assertion per render, not one per sample. */
  const peak = (...xs: Float32Array[]): number => {
    let m = 0;
    for (const x of xs) for (const y of x) m = Number.isFinite(y) ? Math.max(m, Math.abs(y)) : Infinity;
    return m;
  };

  it('stays finite and within ±2 whatever the params say', () => {
    for (const a of hostile) {
      for (const b of hostile) {
        const { master, slave } = render({
          frequency: a, detune: b, syncPitch: b, masterCents: a, slaveCents: b,
          mode: a, wave1: b, wave2: a, width1: b, width2: a,
        }, 1024);
        expect(peak(master, slave), `params ${a} / ${b}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('survives a-rate arrays that jump between extremes sample by sample', () => {
    const wild = Float32Array.from({ length: BLOCK }, (_, i) => hostile[i % hostile.length]!);
    const { master, slave } = render({ frequency: wild, detune: wild, syncPitch: wild, mode: HARD, wave2: SQUARE }, 4096);
    expect(peak(master, slave)).toBeLessThanOrEqual(2);
  });
});

describe('the idle gate (REQ-the-pair-idles-with-the-voice)', () => {
  it('outputs silence while inactive and resumes on reactivation', () => {
    const proc = new Processor({});
    const p = params({ frequency: 440, mode: HARD });
    const a = new Float32Array(BLOCK), b = new Float32Array(BLOCK);
    proc.port.onmessage?.({ data: false });
    proc.process([], [[a], [b]], p);
    expect(a.every((v) => v === 0) && b.every((v) => v === 0)).toBe(true);
    proc.port.onmessage?.({ data: true });
    for (let i = 0; i < 4; i++) proc.process([], [[a], [b]], p);
    expect(a.some((v) => v !== 0)).toBe(true);
  });
});
