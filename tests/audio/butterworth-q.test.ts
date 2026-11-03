// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUTTERWORTH_Q_DB } from '../../src/audio/effects/effect';
import { Reverb } from '../../src/audio/effects/reverb';
import { Chorus } from '../../src/audio/effects/chorus';
import { Dirt } from '../../src/audio/effects/dirt';
import { DrumMachine } from '../../src/audio/transport/drum-machine';
import { SamplerMachine } from '../../src/audio/transport/sampler-machine';
import { Performance } from '../../src/audio/transport/performance';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { makeMockAudioContext, makeMockBiquadFilter, type MockAudioContext } from './mock-audio-context';
import { createPerfStub, makeTransportRig } from './transport/rig';
import { TestClock } from './transport/test-clock';

/**
 * effects.md REQ-a-fixed-filter-is-a-true-butterworth. Web Audio reads a
 * lowpass/highpass Q in dB, so the linear 0.7 / 0.707 / √½ these were written
 * with put a +1.7 dB bump just below each cutoff: in Dirt's tone at 3 kHz, the
 * reverb and chorus darkening, every drum and sampler tone, the editor's edits,
 * and on the master through the resting DJ filter.
 */
const biquads = (ctx: MockAudioContext): ReturnType<typeof makeMockBiquadFilter>[] =>
  ctx.createBiquadFilter.mock.results.map((r) => r.value as ReturnType<typeof makeMockBiquadFilter>);
const lowpasses = (ctx: MockAudioContext) => biquads(ctx).filter((f) => f.type === 'lowpass');
const lastTarget = (p: { setTargetAtTime: { mock: { calls: unknown[][] } } }) =>
  p.setTargetAtTime.mock.calls.at(-1)?.[0] as number | undefined;

describe('every fixed lowpass/highpass is a true Butterworth (REQ-a-fixed-filter-is-a-true-butterworth)', () => {
  it('the reverb damp, the chorus tone and Dirt\'s tone', () => {
    for (const make of [
      (c: AudioContext) => new Reverb(c),
      (c: AudioContext) => new Chorus(c),
      (c: AudioContext) => new Dirt(c),
    ]) {
      const ctx = makeMockAudioContext();
      make(ctx as unknown as AudioContext);
      const lps = lowpasses(ctx);
      expect(lps).toHaveLength(1);
      expect(lps[0]!.Q.value).toBe(BUTTERWORTH_Q_DB);
    }
  });

  it('every drum track\'s tone', () => {
    const ctx = makeMockAudioContext();
    const perf = createPerfStub();
    const { clock, patterns, arrangement } = makeTransportRig(perf);
    const dm = new DrumMachine(ctx as unknown as AudioContext, clock, patterns, arrangement,
      perf as unknown as Performance, (ctx as unknown as AudioContext).createGain(), true);
    const tones = lowpasses(ctx);
    expect(tones.length).toBe(dm.tracks.length);
    for (const t of tones) expect(t.Q.value).toBe(BUTTERWORTH_Q_DB);
  });

  it('a sampler slot\'s tone at res 0, while res 1 keeps its 12 dB peak', () => {
    const ctx = makeMockAudioContext();
    const perf = createPerfStub();
    const { clock, patterns, arrangement } = makeTransportRig(perf);
    const sm = new SamplerMachine(ctx as unknown as AudioContext, clock, patterns, arrangement,
      perf, (ctx as unknown as AudioContext).createGain());
    const tones = lowpasses(ctx);
    for (const t of tones) expect(t.Q.value).toBe(BUTTERWORTH_Q_DB);
    sm.setSlotRes(0, 1);
    expect(lastTarget(tones[0]!.Q)).toBe(12);
    sm.setSlotRes(0, 0);
    expect(lastTarget(tones[0]!.Q)).toBe(BUTTERWORTH_Q_DB);
  });

  it('a resting DJ filter side, while a sweeping side keeps its resonance curve', () => {
    const ctx = makeMockAudioContext();
    const bus = new ParamBus();
    registerDefaults(bus);
    const djLow = makeMockBiquadFilter();
    const djHigh = makeMockBiquadFilter();
    djLow.type = 'lowpass';
    djHigh.type = 'highpass';
    const timer = { start: () => {}, stop: () => {}, running: false };
    const perf = new Performance(ctx as unknown as AudioContext, new TestClock(), bus,
      djLow as unknown as BiquadFilterNode, djHigh as unknown as BiquadFilterNode, timer as never);

    perf.setDjFilter(-0.5);
    expect(lastTarget(djLow.Q)).toBeCloseTo(0.7 + 0.5 * 3, 12); // the sweep's own curve, unchanged
    expect(lastTarget(djHigh.Q)).toBe(BUTTERWORTH_Q_DB);         // the other side rests
    perf.setDjFilter(0);
    expect(lastTarget(djLow.Q)).toBe(BUTTERWORTH_Q_DB);
    expect(lastTarget(djHigh.Q)).toBe(BUTTERWORTH_Q_DB);
  });

  it('the DJ pair is built at rest, and the editor\'s filter edits are Butterworth', () => {
    // The Engine and the offline render are not built under the mock here, so
    // their constructors are pinned at the source (engine-stereo.test.ts's way; a
    // path from the repo root, since jsdom's URL does not resolve file: URLs).
    const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');
    const engine = src('audio/engine.ts');
    expect(engine).toContain('this.djLow.Q.value = BUTTERWORTH_Q_DB;');
    expect(engine).toContain('this.djHigh.Q.value = BUTTERWORTH_Q_DB;');
    expect(src('audio/recorder/offline-render.ts')).toContain('biquad.Q.value = BUTTERWORTH_Q_DB;');
  });
});
