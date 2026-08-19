import { describe, it, expect, vi } from 'vitest';
import { SamplerMachine } from '../../../src/audio/transport/sampler-machine';
import { makeMockAudioContext, makeStubBuffer, type MockAudioContext } from '../mock-audio-context';
import { createPerfStub, makeTransportRig } from './rig';

function build(perf = createPerfStub()) {
  const ctx: MockAudioContext = makeMockAudioContext();
  const { clock, patterns, arrangement } = makeTransportRig(perf);
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
    // "No cut" is a ramp DOWN to 0 that never happens — not "no scheduling at
    // all": every hit now ramps up from 0 as its attack (REQ-11).
    const down = g.gain.linearRampToValueAtTime.mock.calls.filter((c: number[]) => c[0] === 0);
    expect(down).toHaveLength(0);
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

  // sampler.md REQ-8 — a tied cell gets no choke at all, so before this a long
  // sample played out in full after Stop, and Panic could not silence it either
  // (that only kills synth voices). Engine owns *when* to call this: a stop that
  // ends a capture must keep its tail, so the machine only owns the mechanism.
  describe('stopAll cuts in-flight one-shots (v4, REQ-8)', () => {
    it('fades and stops a tied hit that had no choke of its own', () => {
      const { ctx, clock, patterns, sm } = build();
      sm.setEnabled(true);
      sm.setBuffer(0, makeStubBuffer());
      patterns.setSamplerCell(0, 0, { on: true, velocity: 0.6, gate: 1, tie: true });
      clock.fireTick(0);

      const src = ctx.createBufferSource.mock.results[0]!.value;
      const g = ctx.createGain.mock.results.at(-1)!.value; // per-hit velocity gain
      expect(src.stop).not.toHaveBeenCalled(); // tie ⇒ nothing scheduled

      ctx.currentTime = 4;
      sm.stopAll();

      expect(g.gain.cancelScheduledValues).toHaveBeenCalledWith(4);
      expect(g.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 4.005);
      expect(src.stop).toHaveBeenCalledWith(4.03);
    });

    it('leaves a finished hit alone — onended drops it from the in-flight set', () => {
      const { ctx, clock, patterns, sm } = build();
      sm.setEnabled(true);
      sm.setBuffer(0, makeStubBuffer());
      patterns.setSamplerCell(0, 0, { on: true, velocity: 0.6 });
      clock.fireTick(0);

      const src = ctx.createBufferSource.mock.results[0]!.value;
      src.onended?.();          // the sample ran out on its own
      sm.stopAll();

      expect(src.stop).not.toHaveBeenCalled();
      expect(src.disconnect).toHaveBeenCalled();
    });

    it('is not wired to the clock itself — the stop policy lives in Engine', () => {
      const { ctx, clock, patterns, sm } = build();
      sm.setEnabled(true);
      sm.setBuffer(0, makeStubBuffer());
      patterns.setSamplerCell(0, 0, { on: true, velocity: 0.6, gate: 1, tie: true });
      clock.fireTick(0);

      const src = ctx.createBufferSource.mock.results[0]!.value;
      clock.fireStop();
      expect(src.stop).not.toHaveBeenCalled();
    });
  });

  // sampler.md REQ-6 — the single hook sample-persistence.md mirrors slots off.
  it('notifies onBufferChange for a filled and a cleared slot', () => {
    const { sm } = build();
    const seen: number[] = [];
    const off = sm.onBufferChange((slot) => seen.push(slot));

    sm.setBuffer(3, makeStubBuffer());
    sm.setBuffer(3, null);
    sm.setBuffer(99, makeStubBuffer()); // out of range: no slot changed, no event
    expect(seen).toEqual([3, 3]);

    off();
    sm.setBuffer(0, makeStubBuffer());
    expect(seen).toEqual([3, 3]);
  });
});

/**
 * sampler.md REQ-11, regression.
 *
 * The per-hit gain was assigned (`gain.value = velocity`) rather than ramped, so a
 * sample whose first frame is not near zero started on a full-scale step — a click
 * on every hit. User audio is exactly the material we cannot assume anything
 * about. And the start was clamped out of the past while `chokeAt` kept the stale
 * time, so a short gate collapsed and could drop the hit entirely.
 */
describe('a slot starts from zero and carries its choke (v7, REQ-11)', () => {
  it('ramps up from 0 instead of jumping to velocity', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true, velocity: 0.6 });
    clock.fireTick(0);

    const g = ctx.createGain.mock.results.at(-1)!.value;
    const src = ctx.createBufferSource.mock.results[0]!.value;
    const startAt = src.start.mock.calls[0]![0] as number;

    expect(g.gain.value).not.toBe(0.6);                                  // never assigned
    expect(g.gain.setValueAtTime).toHaveBeenCalledWith(0, startAt);      // from silence
    expect(g.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.6, startAt + 0.0005);
  });

  it('shifts the choke by the same delta when the start is clamped out of the past', () => {
    const { ctx, clock, patterns, sm } = build();
    sm.setEnabled(true);
    sm.setBuffer(0, makeStubBuffer());
    patterns.setSamplerCell(0, 0, { on: true, velocity: 0.6, gate: 0.5 });

    ctx.currentTime = 2;              // "now" is well past the tick's scheduled time
    clock.fireTick(0);                // …which schedules at 0

    const g = ctx.createGain.mock.results.at(-1)!.value;
    const src = ctx.createBufferSource.mock.results[0]!.value;
    const startAt = src.start.mock.calls[0]![0] as number;
    const stopAt = src.stop.mock.calls[0]![0] as number;

    expect(startAt).toBe(2);                        // clamped forward
    expect(stopAt).toBeGreaterThan(startAt);        // and the cut moved with it
    // The gate is still ahead of the hit, not behind it — so the hit sounds.
    const cut = g.gain.setValueAtTime.mock.calls.find((c: number[]) => c[0] === 0.6)?.[1] as number;
    expect(cut).toBeGreaterThan(startAt);
  });
});
