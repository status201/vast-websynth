import { describe, it, expect, vi } from 'vitest';
import { SamplerMachine } from '../../../src/audio/transport/sampler-machine';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import type { Performance } from '../../../src/audio/transport/performance';
import { PatternStore } from '../../../src/state/patterns';
import { TestClock } from './test-clock';
import { makeMockAudioContext, makeStubBuffer, type MockAudioContext } from '../mock-audio-context';

function perfStub(mapStep: (s: number) => number = (s) => s) {
  return { mapStep, fillActive: false, setFill() {} } as unknown as Performance;
}

function build(perf = perfStub()) {
  const ctx: MockAudioContext = makeMockAudioContext();
  const clock = new TestClock();
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, clock);
  const samplerBus = (ctx as unknown as AudioContext).createGain();
  const sm = new SamplerMachine(
    ctx as unknown as AudioContext,
    clock,
    patterns,
    arrangement,
    perf,
    samplerBus,
  );
  return { ctx, clock, patterns, arrangement, sm };
}

describe('SamplerMachine', () => {
  it('does not play an empty slot even when the step is active', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    patterns.setSamplerCell(0, 0, { on: true, velocity: 0.8 });
    clock.fireTick(0);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('plays a loaded slot on an active step', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true, velocity: 0.6 });
    clock.fireTick(0);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true });
    clock.fireTick(0);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('skips a muted slot', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    sm.setBuffer(1, makeStubBuffer());
    patterns.setSamplerCell(1, 0, { on: true });
    sm.setSlotMute(1, true);
    clock.fireTick(0);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it('reads the bank the Arrangement selects', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    patterns.setSamplerEditBank(2); // disabled lane → play bank tracks edit bank
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true });
    clock.fireTick(0); // arrangement recomputes samplerPlayBank = 2 at the bar
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('notifies step listeners with the mapped index', () => {
    const { clock, sm } = build();
    sm.setEnabled(true);
    const steps: number[] = [];
    sm.onStep((s) => steps.push(s));
    clock.fireTicks(3);
    expect(steps).toEqual([0, 1, 2]);
  });

  it('plays ratchet sub-hits evenly spaced across the step', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true, ratchet: 3 });
    clock.fireTick(0);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(3);
    const sub = clock.sixteenthDuration() / 3;
    const starts = ctx.createBufferSource.mock.results.map(
      (r) => (r.value as { start: ReturnType<typeof vi.fn> }).start.mock.calls[0]![0] as number,
    );
    expect(starts).toEqual([0, sub, 2 * sub]);
  });

  it('chokes the hit at gate × step duration when gate < 1', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true, velocity: 0.6, gate: 0.5 });
    clock.fireTick(0);
    const cut = clock.sixteenthDuration() * 0.5;
    const src = ctx.createBufferSource.mock.results[0]!.value;
    const g = ctx.createGain.mock.results.at(-1)!.value; // per-hit velocity gain
    expect(g.gain.setValueAtTime).toHaveBeenCalledWith(0.6, cut);
    expect(g.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, cut + 0.005);
    expect(src.stop).toHaveBeenCalledWith(cut + 0.03);
  });

  it('does not schedule a cut at gate 1 (natural decay)', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true });
    clock.fireTick(0);
    const src = ctx.createBufferSource.mock.results[0]!.value;
    const g = ctx.createGain.mock.results.at(-1)!.value;
    expect(g.gain.setValueAtTime).not.toHaveBeenCalled();
    expect(src.stop).not.toHaveBeenCalled();
  });

  it('skips the step when the probability roll fails', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true, prob: 0.5 });
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    clock.fireTick(0);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    rnd.mockRestore();
  });
});
