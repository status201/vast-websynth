import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Zoetrope DSP, tested by importing the worklet file directly with the audio-
 * thread globals stubbed (the house pattern — see compressor-worklet.test.ts).
 *
 * These assert *behaviour* — passthrough before the library fills, period
 * locking, freeze semantics, the mode-change re-anchor and boundedness — not
 * golden samples. Boundedness is mandatory under ADR-010.
 */

const SR = 48000;
const BLOCK = 128;
const OUT_CLAMP = 4;
const METER_BLOCKS = 12;

interface CyclesMessage {
  type: string;
  peaks: Float32Array;
  head: number;
  lag: number;
  count: number;
  hz: number;
}

interface ProcessorLike {
  port: { postMessage: ReturnType<typeof vi.fn>; onmessage: ((e: { data: unknown }) => void) | null };
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
  // White-box access to the ring-buffer bookkeeping a couple of tests pin.
  cycCount: number;
  tapCount: number;
  writePos: number;
  curStart: number;
  lastCross: number;
}

let Processor: new () => ProcessorLike;

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
  await import('../../public/worklets/zoetrope.js' as string);
});

const DEFAULTS: Record<string, number> = {
  frequency: 0,
  scatter: 0,
  chaos: 0.5,
  smear: 0.25,
  sieve: 0,
  depth: 12,
  mix: 1,
  freeze: 0,
  source: 0,
  selectMode: 0,
  taps: 8,
  sub: 0,
  xfadeFloor: 16,
};

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries({ ...DEFAULTS, ...over })) out[k] = new Float32Array([v]);
  return out;
}

interface RunResult {
  out: number[];
  input: number[];
}

/** Feed `blocks` blocks of a sine and collect the left output. */
function runSine(
  proc: ProcessorLike,
  params: Record<string, Float32Array>,
  blocks: number,
  freq = 300,
  amp = 1,
): RunResult {
  const inc = (2 * Math.PI * freq) / SR;
  const out: number[] = [];
  const input: number[] = [];
  let phase = (proc as unknown as { _phase?: number })._phase ?? 0;
  for (let b = 0; b < blocks; b++) {
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const s = Math.sin(phase) * amp;
      inL[i] = s;
      inR[i] = s;
      phase += inc;
    }
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    proc.process([[inL, inR]], [[oL, oR]], params);
    for (let i = 0; i < BLOCK; i++) {
      out.push(oL[i]!);
      input.push(inL[i]!);
    }
  }
  (proc as unknown as { _phase?: number })._phase = phase;
  return { out, input };
}

function enableMetering(proc: ProcessorLike): void {
  proc.port.onmessage?.({ data: { type: 'meter', on: true } });
}

function lastCycles(proc: ProcessorLike): CyclesMessage | undefined {
  const calls = proc.port.postMessage.mock.calls;
  const last = calls[calls.length - 1];
  return last ? (last[0] as CyclesMessage) : undefined;
}

describe('zoetrope worklet', () => {
  it('passes the input through untouched until two cycles are stored', () => {
    const proc = new Processor();
    // One block at 300 Hz is 128 samples — less than a single 160-sample cycle.
    const { out, input } = runSine(proc, makeParams({ frequency: 300 }), 1);
    expect(proc.cycCount).toBeLessThan(2);
    expect(out).toEqual(input);
  });

  it('replays cycles at the locked pitch', () => {
    const proc = new Processor();
    const params = makeParams({ frequency: 300 });
    enableMetering(proc);
    runSine(proc, params, 40, 300);
    const m = lastCycles(proc);
    expect(m).toBeDefined();
    expect(m!.type).toBe('cycles');
    // The output period is driven by the pitch, not by whichever cycle was picked.
    expect(m!.hz).toBeCloseTo(300, 0);
  });

  it('reads the newest cycle every period while scatter is 0', () => {
    const proc = new Processor();
    const params = makeParams({ frequency: 300, scatter: 0 });
    enableMetering(proc);
    runSine(proc, params, 60, 300);
    expect(lastCycles(proc)!.lag).toBe(1);
  });

  it('reaches back into the library once scatter is up', () => {
    const proc = new Processor();
    const params = makeParams({ frequency: 300, scatter: 1, chaos: 0.9, depth: 16 });
    enableMetering(proc);
    const lags = new Set<number>();
    for (let i = 0; i < 30; i++) {
      runSine(proc, params, METER_BLOCKS, 300);
      const m = lastCycles(proc);
      if (m) lags.add(m.lag);
    }
    expect(lags.size).toBeGreaterThan(1);
  });

  it('stops recording while frozen', () => {
    const proc = new Processor();
    const running = makeParams({ frequency: 300 });
    runSine(proc, running, 40, 300);
    const before = proc.cycCount;
    expect(before).toBeGreaterThan(2);

    runSine(proc, makeParams({ frequency: 300, freeze: 1 }), 40, 300);
    expect(proc.cycCount).toBe(before);
  });

  it('keeps the write cursors live across a detection-mode change', () => {
    const proc = new Processor();
    // Pitched detection first — this advances curStart on its own virtual grid.
    runSine(proc, makeParams({ frequency: 300 }), 60, 300);
    // Then drop to zero-crossing detection. Without the re-anchor, lastCross
    // still points wherever it was left before pitched mode took over, and the
    // next stored "cycle" spans megabytes of overwritten history.
    const { out } = runSine(proc, makeParams({ frequency: 0 }), 60, 300);

    expect(proc.writePos - proc.lastCross).toBeLessThan(1 << 17);
    expect(proc.writePos - proc.curStart).toBeLessThan(1 << 17);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('stays bounded and finite at every extreme (ADR-010)', () => {
    for (const sieve of [-1, 0, 1]) {
      const proc = new Processor();
      const params = makeParams({
        frequency: 300,
        scatter: 1,
        chaos: 1,
        smear: 1,
        sieve,
        depth: 64,
        taps: 16,
        sub: 1,
        mix: 1,
        xfadeFloor: 4,
      });
      const { out } = runSine(proc, params, 120, 300, 1);
      expect(out.every((v) => Number.isFinite(v))).toBe(true);
      expect(Math.max(...out.map((v) => Math.abs(v)))).toBeLessThanOrEqual(OUT_CLAMP);
    }
  });

  it('resolves no sieve taps while sieve is 0, and some once it is not', () => {
    const off = new Processor();
    runSine(off, makeParams({ frequency: 300, sieve: 0 }), 40, 300);
    expect(off.tapCount).toBe(0);

    const on = new Processor();
    runSine(on, makeParams({ frequency: 300, sieve: -1, taps: 8 }), 40, 300);
    expect(on.tapCount).toBeGreaterThan(1);
  });

  it('posts nothing until metering is asked for', () => {
    const proc = new Processor();
    runSine(proc, makeParams({ frequency: 300 }), 60, 300);
    expect(proc.port.postMessage).not.toHaveBeenCalled();
  });

  it('posts cycle frames about every 12 blocks once metering is on', () => {
    const proc = new Processor();
    const params = makeParams({ frequency: 300 });
    runSine(proc, params, 40, 300); // fill the library first
    enableMetering(proc);
    proc.port.postMessage.mockClear();

    const blocks = METER_BLOCKS * 5;
    runSine(proc, params, blocks, 300);
    expect(proc.port.postMessage.mock.calls.length).toBe(5);

    const m = lastCycles(proc)!;
    expect(m.peaks.length).toBe(m.count);
    expect(m.count).toBeGreaterThan(0);
    expect(m.peaks.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });

  it('reports only the window depth can reach, never the whole library', () => {
    const proc = new Processor();
    const params = makeParams({ frequency: 300, depth: 6 });
    runSine(proc, params, 80, 300); // stores far more than 6 cycles
    enableMetering(proc);
    runSine(proc, params, METER_BLOCKS, 300);

    expect(proc.cycCount).toBeGreaterThan(6);
    const m = lastCycles(proc)!;
    expect(m.count).toBe(6);
    expect(m.peaks.length).toBe(6);
    expect(m.lag).toBeLessThanOrEqual(6);
  });

  it('drops the library on clear', () => {
    const proc = new Processor();
    runSine(proc, makeParams({ frequency: 300 }), 40, 300);
    expect(proc.cycCount).toBeGreaterThan(2);
    proc.port.onmessage?.({ data: 'clear' });
    expect(proc.cycCount).toBe(0);
  });

  it('finds cycles from zero crossings with no pitch signal', () => {
    const proc = new Processor();
    enableMetering(proc);
    runSine(proc, makeParams({ frequency: 0 }), 60, 300);
    expect(proc.cycCount).toBeGreaterThan(2);
    // ~160 samples per cycle at 300 Hz — the detected period should land near it.
    expect(lastCycles(proc)!.hz).toBeGreaterThan(200);
    expect(lastCycles(proc)!.hz).toBeLessThan(450);
  });

  /**
   * Regressions found by rendering the real graph (`npm run bench:audio`), not
   * by these unit tests — both measured ~40x the discontinuity rate of a
   * bypassed render before the fix. See specs/recipes/verify-audio-by-ear.md.
   */
  describe('splice continuity (bench regressions)', () => {
    /** Largest per-sample step, relative to the input's own largest step. */
    function stepRatio(params: Record<string, Float32Array>, freq = 300): number {
      const proc = new Processor();
      const { out, input } = runSine(proc, params, 120, freq);
      const half = out.length >> 1;
      let inMax = 0;
      let outMax = 0;
      for (let i = half; i < out.length; i++) {
        inMax = Math.max(inMax, Math.abs(input[i]! - input[i - 1]!));
        outMax = Math.max(outMax, Math.abs(out[i]! - out[i - 1]!));
      }
      return outMax / inMax;
    }

    it('crossfades the sub octave instead of stepping the polarity', () => {
      // `sub` gates/inverts alternate cycles; applying that as a bare gain step
      // at the splice was a full-scale discontinuity every other cycle.
      expect(stepRatio(makeParams({ frequency: 300, sub: 1 }))).toBeLessThan(1.5);
      expect(stepRatio(makeParams({ frequency: 300, sub: 0.5 }))).toBeLessThan(1.5);
    });

    it('locks the zero-crossing detector to one coherent period', () => {
      // A bright/polyphonic signal crosses zero many times per period. Without
      // hysteresis + a coherence window the detector chased every partial and
      // stored cycles whose lengths spanned an order of magnitude.
      const proc = new Processor();
      const params = makeParams({ frequency: 0 }); // zero-crossing fallback
      let phase = 0;
      for (let b = 0; b < 200; b++) {
        const inL = new Float32Array(BLOCK);
        const inR = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK; i++) {
          // Two notes a fifth apart, several harmonics each.
          let s = 0;
          for (let k = 1; k <= 5; k++) s += Math.sin(k * phase) / k + Math.sin(k * phase * 1.5) / k;
          inL[i] = s * 0.3;
          inR[i] = s * 0.3;
          phase += (2 * Math.PI * 200) / SR;
        }
        proc.process([[inL, inR]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], params);
      }
      const lens: number[] = [];
      const cycLen = (proc as unknown as { cycLen: Float64Array }).cycLen;
      for (let i = 0; i < proc.cycCount; i++) lens.push(cycLen[i]!);
      expect(lens.length).toBeGreaterThan(4);
      const lo = Math.min(...lens);
      const hi = Math.max(...lens);
      // Was 24..250 — better than 10x spread — before the lock; now ~2.5x.
      // Not tighter, because on two simultaneous notes the "true" period is
      // genuinely ambiguous (the 200 Hz partial and the 100 Hz common period
      // are both defensible, and that is a factor of 2 on its own). The point
      // of the guard is that the detector settles on *a* period instead of
      // chasing every partial.
      expect(hi / lo).toBeLessThan(3);
    });
  });

  it('outputs silence when there is no input at all', () => {
    const proc = new Processor();
    const oL = new Float32Array(BLOCK).fill(1);
    const oR = new Float32Array(BLOCK).fill(1);
    proc.process([], [[oL, oR]], makeParams());
    expect(Array.from(oL).every((v) => v === 0)).toBe(true);
    expect(Array.from(oR).every((v) => v === 0)).toBe(true);
  });
});
