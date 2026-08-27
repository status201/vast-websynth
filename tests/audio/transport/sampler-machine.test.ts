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

/**
 * sampler.md REQ-12 / REQ-13 (v8).
 *
 * A slot used to be a bare BufferSource: no level, pan, filter, pitch, trim,
 * reverse or envelope, while every synthesised drum track had all of them. The
 * risk in adding ten params at once is that one of them stops being a no-op at its
 * default and silently re-voices the whole demo corpus (ADR-006) — so the second
 * test here pins the default CODE PATH, not just the default values.
 */
describe('the per-slot channel and voice window (v8, REQ-12/REQ-13)', () => {
  const ATK = 0.0005; // SAMPLER_ATTACK
  const twoSec = () => makeStubBuffer(88200, 44100); // 2.0 s

  type Rig = ReturnType<typeof build>;
  function fire(rig: Rig, cell: Record<string, unknown> = {}) {
    rig.sm.setEnabled(true);
    rig.patterns.setSamplerCell(0, 0, { on: true, velocity: 0.6, ...cell });
    rig.clock.fireTick(0);
  }
  const lastSrc = (ctx: Rig['ctx']) => ctx.createBufferSource.mock.results[0]!.value;
  const hitGain = (ctx: Rig['ctx']) => ctx.createGain.mock.results.at(-1)!.value;

  it('builds each slot at its no-op setting', () => {
    const { ctx, sm } = build();
    expect(sm.slotGains[0]!.gain.value).toBe(1); // unity, NOT the drum machine's 0.85
    const tone = ctx.createBiquadFilter.mock.results[0]!.value;
    expect(tone.type).toBe('lowpass');
    expect(tone.frequency.value).toBeCloseTo(20000, 0); // open
    expect(tone.Q.value).toBeCloseTo(0.7, 5); // flat
    expect(ctx.createStereoPanner.mock.results[0]!.value.pan.value).toBe(0);
  });

  it('forces the pan stage stereo, so a mono clip is not 3 dB down (regression)', () => {
    const { sm } = build();
    // At pan 0 a StereoPannerNode passes STEREO through but applies equal-power
    // gain to MONO. Without the explicit up-mix, every mono sample in the corpus
    // would have got quieter the day the channel landed.
    const vol = sm.slotGains[0]! as unknown as {
      channelCount: number; channelCountMode: string; channelInterpretation: string;
    };
    expect(vol.channelCount).toBe(2);
    expect(vol.channelCountMode).toBe('explicit');
    expect(vol.channelInterpretation).toBe('speakers');
  });

  it('takes the pre-v8 code path when every slot param is at its default', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    fire(rig);
    const src = lastSrc(rig.ctx);
    expect(src.playbackRate.value).toBe(1); // no rate write
    expect(src.start.mock.calls[0]).toHaveLength(1); // no start offset
    expect(src.stop).not.toHaveBeenCalled(); // no scheduled cut
  });

  it('pitches by varispeed', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotPitch(0, -12);
    fire(rig);
    expect(lastSrc(rig.ctx).playbackRate.value).toBeCloseTo(0.5, 6);
  });

  it('starts and ends a trimmed window where it says', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotStart(0, 0.25); // 0.5 s in
    rig.sm.setSlotEnd(0, 0.5); // 1.0 s in — a 0.5 s window
    fire(rig);
    const src = lastSrc(rig.ctx);
    const g = hitGain(rig.ctx);
    expect(src.start).toHaveBeenCalledWith(0, 0.5);
    expect(g.gain.setValueAtTime).toHaveBeenCalledWith(0.6, 0.5);
    expect(g.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.505);
    expect(src.stop).toHaveBeenCalledWith(0.53);
  });

  it('scales the window end by the pitch, because varispeed changes length', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotEnd(0, 0.5); // a 1 s window …
    rig.sm.setSlotPitch(0, -12); // … at half speed is 2 s of sound
    fire(rig);
    expect(lastSrc(rig.ctx).stop).toHaveBeenCalledWith(2 + 0.03);
  });

  it('states the window in forward coordinates even when reversed', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotEnd(0, 0.25); // the first 0.5 s of the sample …
    rig.sm.setSlotRev(0, true);
    fire(rig);
    const src = lastSrc(rig.ctx);
    // … is the LAST 0.5 s of the reversed copy.
    expect(src.start).toHaveBeenCalledWith(0, 1.5);
    expect(src.stop).toHaveBeenCalledWith(0.5 + 0.03);
    expect(rig.ctx.createBuffer).toHaveBeenCalledTimes(1); // the copy was built
  });

  it('reuses the reversed copy across hits', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotRev(0, true);
    fire(rig);
    rig.sm.triggerSlot(0); // the audition path, so a second hit is unambiguous
    expect(rig.ctx.createBuffer).toHaveBeenCalledTimes(1);
  });

  it('drops the reversed copy when the slot gets new audio (regression)', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotRev(0, true);
    fire(rig);
    rig.sm.setBuffer(0, twoSec()); // a different sample in the same slot
    rig.sm.triggerSlot(0);
    // Without the drop, the second hit would play the FIRST sample backwards.
    expect(rig.ctx.createBuffer).toHaveBeenCalledTimes(2);
  });

  it('ends the hit on its decay when nothing shorter applies', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotDecay(0, 0.5);
    fire(rig);
    expect(hitGain(rig.ctx).gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, ATK + 0.5);
    expect(lastSrc(rig.ctx).stop).toHaveBeenCalledWith(ATK + 0.5 + 0.03);
  });

  it('honours a longer attack (REQ-11 still floors a shorter one)', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotAttack(0, 0.2);
    fire(rig);
    expect(hitGain(rig.ctx).gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.6, 0.2);
  });

  it('cuts once, at whichever reason comes first', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotEnd(0, 0.5); // a 1 s window …
    rig.sm.setSlotDecay(0, 2); // … and a 2 s decay, both beaten by the gate
    fire(rig, { gate: 0.5 });
    const cut = rig.clock.sixteenthDuration() * 0.5;
    expect(lastSrc(rig.ctx).stop).toHaveBeenCalledTimes(1);
    expect(lastSrc(rig.ctx).stop).toHaveBeenCalledWith(cut + 0.03);
    expect(hitGain(rig.ctx).gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, cut + 0.005);
  });

  it('truncates a decay at its own value, so the cut does not jump back up', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotDecay(0, 2);
    fire(rig, { gate: 0.5 });
    const cut = rig.clock.sixteenthDuration() * 0.5;
    const held = 0.6 * (1 - (cut - ATK) / 2);
    const ramp = hitGain(rig.ctx).gain.linearRampToValueAtTime.mock.calls
      .find((c: number[]) => c[1] === cut)?.[0] as number;
    expect(ramp).toBeCloseTo(held, 6);
    expect(ramp).toBeLessThan(0.6);
  });

  it('clamps a crossed window instead of dropping the hit (edge)', () => {
    const rig = build();
    rig.sm.setBuffer(0, twoSec());
    rig.sm.setSlotStart(0, 0.8);
    rig.sm.setSlotEnd(0, 0.2); // below the start
    fire(rig);
    const src = lastSrc(rig.ctx);
    expect(src.start).toHaveBeenCalledWith(0, 1.6);
    expect(src.stop).toHaveBeenCalled(); // it still sounds, just very briefly
  });

  it('ramps the channel params rather than assigning them', () => {
    const { ctx, sm } = build();
    sm.setSlotVol(0, 0.5);
    sm.setSlotPan(0, -1);
    sm.setSlotTone(0, 0);
    sm.setSlotRes(0, 1);
    const tone = ctx.createBiquadFilter.mock.results[0]!.value;
    expect(sm.slotGains[0]!.gain.setTargetAtTime).toHaveBeenCalled();
    expect(ctx.createStereoPanner.mock.results[0]!.value.pan.setTargetAtTime).toHaveBeenCalled();
    expect(tone.frequency.setTargetAtTime).toHaveBeenCalledWith(300, 0, 0.01);
    expect(tone.Q.setTargetAtTime).toHaveBeenCalledWith(12, 0, 0.01);
  });

  it('ignores an out-of-range slot', () => {
    const { sm } = build();
    expect(() => {
      sm.setSlotPitch(99, 12);
      sm.setSlotStart(-1, 0.5);
      sm.setSlotVol(99, 0.5);
    }).not.toThrow();
  });
});

/**
 * sampler.md REQ-14 / REQ-15 (v9).
 *
 * A slot could neither cut another slot nor cut itself, and nothing capped how
 * many hits one slot could stack. The subtle half is *when* a choke is scheduled:
 * hits go out up to a look-ahead early, so cutting at `currentTime` silences the
 * old hit before the new one arrives — a hole precisely where a choke is meant to
 * be seamless, and one that sounds like a dropout rather than like a bug.
 */
describe('choke groups, mono and the voice cap (v9, REQ-14/REQ-15)', () => {
  const twoSec = () => makeStubBuffer(88200, 44100);

  function loaded() {
    const rig = build();
    rig.sm.setEnabled(true);
    for (let i = 0; i < 4; i++) rig.sm.setBuffer(i, twoSec());
    return rig;
  }

  it('cuts a slot sharing its choke group', () => {
    const { ctx, clock, patterns, sm } = loaded();
    sm.setSlotChokeGroup(0, 1);
    sm.setSlotChokeGroup(1, 1);
    patterns.setSamplerCell(1, 0, { on: true, velocity: 0.8 }); // open hat, step 0
    patterns.setSamplerCell(0, 1, { on: true, velocity: 0.8 }); // closed hat, step 1

    clock.fireTick(0);
    const open = ctx.createGain.mock.results.at(-1)!.value;
    const openSrc = ctx.createBufferSource.mock.results.at(-1)!.value;
    expect(openSrc.stop).not.toHaveBeenCalled();

    clock.fireTick(0.08);
    expect(open.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.085);
    expect(openSrc.stop).toHaveBeenCalledWith(0.11);
  });

  it('schedules the cut at the new hit, not at currentTime (regression)', () => {
    const { ctx, clock, patterns, sm } = loaded();
    sm.setSlotChokeGroup(0, 1);
    sm.setSlotChokeGroup(1, 1);
    patterns.setSamplerCell(1, 0, { on: true });
    patterns.setSamplerCell(0, 1, { on: true });

    clock.fireTick(0);
    const open = ctx.createGain.mock.results.at(-1)!.value;
    clock.fireTick(0.08); // 80 ms ahead of ctx.currentTime, which is still 0

    // The fade starts at the new hit's time. At currentTime it would open an
    // 80 ms hole before the closed hat ever sounds.
    const at = open.gain.setValueAtTime.mock.calls.at(-1)![1] as number;
    expect(at).toBeCloseTo(0.08, 6);
    expect(ctx.currentTime).toBe(0);
  });

  it('leaves slots outside the group alone (edge)', () => {
    const { ctx, clock, patterns, sm } = loaded();
    sm.setSlotChokeGroup(0, 1);
    // slot 2 stays ungrouped
    patterns.setSamplerCell(2, 0, { on: true });
    patterns.setSamplerCell(0, 1, { on: true });

    clock.fireTick(0);
    const other = ctx.createBufferSource.mock.results.at(-1)!.value;
    clock.fireTick(0.08);
    expect(other.stop).not.toHaveBeenCalled();
  });

  it('groups are independent of one another (edge)', () => {
    const { ctx, clock, patterns, sm } = loaded();
    sm.setSlotChokeGroup(1, 1);
    sm.setSlotChokeGroup(0, 2); // a different group
    patterns.setSamplerCell(1, 0, { on: true });
    patterns.setSamplerCell(0, 1, { on: true });

    clock.fireTick(0);
    const first = ctx.createBufferSource.mock.results.at(-1)!.value;
    clock.fireTick(0.08);
    expect(first.stop).not.toHaveBeenCalled();
  });

  it('a mono slot cuts its own previous hit', () => {
    const { ctx, sm } = loaded();
    sm.setSlotMono(0, true);
    sm.triggerSlot(0);
    const first = ctx.createBufferSource.mock.results.at(-1)!.value;
    sm.triggerSlot(0);
    expect(first.stop).toHaveBeenCalled();
  });

  it('a poly slot still layers — the default is the pre-v9 behaviour (regression)', () => {
    const { ctx, sm } = loaded();
    sm.triggerSlot(0);
    const first = ctx.createBufferSource.mock.results.at(-1)!.value;
    sm.triggerSlot(0);
    expect(first.stop).not.toHaveBeenCalled();
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(2);
  });

  it('a mono slot does not cut a different slot (edge)', () => {
    const { ctx, sm } = loaded();
    sm.setSlotMono(0, true);
    sm.triggerSlot(1);
    const other = ctx.createBufferSource.mock.results.at(-1)!.value;
    sm.triggerSlot(0);
    expect(other.stop).not.toHaveBeenCalled();
  });

  it('steals the oldest hit rather than stacking without limit (REQ-15)', () => {
    const { ctx, sm } = loaded();
    sm.triggerSlot(0);
    const oldest = ctx.createBufferSource.mock.results.at(-1)!.value;
    // 16 is the cap; the 17th is what forces a steal.
    for (let i = 0; i < 16; i++) sm.triggerSlot(0);
    expect(oldest.stop).toHaveBeenCalled();
  });

  it('does not steal below the cap (REQ-15, edge)', () => {
    const { ctx, sm } = loaded();
    sm.triggerSlot(0);
    const oldest = ctx.createBufferSource.mock.results.at(-1)!.value;
    for (let i = 0; i < 14; i++) sm.triggerSlot(0);
    expect(oldest.stop).not.toHaveBeenCalled();
  });

  it('never pushes an already-ending hit later (edge)', () => {
    const { ctx, clock, patterns, sm } = loaded();
    sm.setSlotChokeGroup(0, 1);
    sm.setSlotChokeGroup(1, 1);
    // A short gate gives slot 1 a stop already scheduled well before the choke.
    patterns.setSamplerCell(1, 0, { on: true, gate: 0.1 });
    patterns.setSamplerCell(0, 1, { on: true });

    clock.fireTick(0);
    const first = ctx.createBufferSource.mock.results.at(-1)!.value;
    const before = first.stop.mock.calls.at(-1)![0] as number;
    clock.fireTick(0.5); // long after the gate has already ended it
    const after = first.stop.mock.calls.at(-1)![0] as number;
    // Re-stopping would EXTEND it: the last stop() call is the one that counts.
    expect(after).toBe(before);
  });
});
