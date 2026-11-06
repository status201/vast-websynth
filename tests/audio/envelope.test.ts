import { describe, it, expect } from 'vitest';
import { Envelope } from '../../src/audio/envelope';
import { makeMockAudioContext } from './mock-audio-context';
import type { MockAudioParam } from './mock-audio-context';

/**
 * Scheduled-automation model (envelopes.md REQ-envelope-scheduling-is-future-time-safe): phase changes anchor at the
 * value the curve reaches at the scheduled time — never the live param value,
 * which is a stale snapshot when the transport schedules ahead (the click bug:
 * a sequenced note's release anchored ~0 and cut the note instantly).
 */

/** Value of a setTargetAtTime curve after dt. */
const approach = (from: number, target: number, tau: number, dt: number) =>
  target + (from - target) * Math.exp(-dt / tau);

function build() {
  const ctx = makeMockAudioContext();
  const env = new Envelope(ctx as unknown as AudioContext);
  const gain = env.out.gain as unknown as MockAudioParam;
  return { ctx, env, gain };
}

/** The value pinned by the last setValueAtTime call. */
const lastAnchor = (gain: MockAudioParam) =>
  gain.setValueAtTime.mock.calls.at(-1) as [number, number];

describe('Envelope future-time-safe scheduling', () => {
  it('release at a future gateEnd anchors the curve value, not the live value (regression)', () => {
    const { env, gain } = build();
    env.setAttack(0.01);
    env.setDecay(0.05);
    env.setSustain(0.8);
    env.setRelease(0.4);
    // Sequencer tick at now=0 schedules attack at 0.1 and release at 0.5.
    env.trigger(0.1, 1);
    env.release_(0.5);
    const [v, t] = lastAnchor(gain);
    expect(t).toBe(0.5);
    // By 0.5 the decay has long settled at sustain * peak = 0.8. The bug
    // anchored gain.value (still 0 — the note hasn't sounded yet).
    expect(v).toBeCloseTo(0.8, 3);
    expect(v).toBeGreaterThan(0);
  });

  it('retrigger over a scheduled release tail anchors the decayed value', () => {
    const { env, gain } = build();
    env.setAttack(0.01);
    env.setDecay(0.05);
    env.setSustain(0.8);
    env.setRelease(0.3); // tau = 0.1
    env.trigger(0.1, 1);
    env.release_(0.5);
    env.trigger(0.6, 1); // 0.1 s into the release
    const [v, t] = lastAnchor(gain);
    expect(t).toBe(0.6);
    expect(v).toBeCloseTo(approach(0.8, 0, 0.3 / 3, 0.1), 4);
  });

  it('tracks the attack curve mid-flight', () => {
    const { env, gain } = build();
    env.setAttack(0.03); // tau = 0.01
    env.setSustain(0.5);
    env.trigger(1, 1);
    env.release_(1.01); // release mid-attack, 0.01 s in
    const [v] = lastAnchor(gain);
    expect(v).toBeCloseTo(approach(0, 1, 0.01, 0.01), 4);
  });

  it('a fresh envelope triggered immediately anchors at 0 (keyboard path unchanged)', () => {
    const { ctx, env, gain } = build();
    ctx.currentTime = 2;
    env.trigger(0); // when in the past clamps to now
    const [v, t] = lastAnchor(gain);
    expect(t).toBe(2);
    expect(v).toBe(0);
  });

  it('a canceled future phase does not haunt later values', () => {
    const { env, gain } = build();
    env.setAttack(0.01);
    env.setDecay(0.05);
    env.setSustain(0.8);
    env.setRelease(0.3);
    env.trigger(0.1, 1);
    env.release_(0.5);
    // Retrigger BEFORE the scheduled release — it must be cancelled from the
    // model too (mirrors cancelScheduledValues), so a later release anchors
    // at full sustain, untouched by the dead release.
    env.trigger(0.4, 1);
    env.release_(0.9);
    const [v] = lastAnchor(gain);
    expect(v).toBeCloseTo(0.8, 3);
    expect(gain.cancelScheduledValues).toHaveBeenLastCalledWith(0.9);
  });

  it('cutFast schedules a fast ramp to 0 from the curve value', () => {
    const { env, gain } = build();
    env.setSustain(1);
    env.trigger(0.1, 1);
    env.cutFast(0.5);
    const [v, t] = lastAnchor(gain);
    expect(t).toBe(0.5);
    expect(v).toBeCloseTo(1, 3);
    expect(gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0.5, 0.003);
  });
});

/**
 * envelopes.md REQ-a-continued-note-rescales-without-restarting: a legato tie
 * moves a sounding envelope to a new velocity's level without a new attack.
 */
describe('Envelope.rescale', () => {
  it('past the attack, moves to the new sustain level along tau — no new attack', () => {
    const { env, gain } = build();
    env.setAttack(0.03);
    env.setDecay(0.06);
    env.setSustain(1);
    env.trigger(0, 0.2);
    gain.setTargetAtTime.mockClear();
    env.rescale(1, 0.6, 0.04);
    const [v, t] = lastAnchor(gain);
    expect(t).toBe(1);
    expect(v).toBeCloseTo(0.2, 4); // anchored where the curve is, not restarted from 0
    // One segment, straight to the new sustain level: no attack toward a peak first.
    expect(gain.setTargetAtTime.mock.calls).toEqual([[0.6, 1, 0.04]]);
    // And the model follows it, so the next phase change anchors truthfully.
    env.release_(1.04);
    expect(lastAnchor(gain)[0]).toBeCloseTo(approach(0.2, 0.6, 0.04, 0.04), 4);
  });

  it('scales by the sustain: the level is what a strike at the new peak would hold', () => {
    const { env, gain } = build();
    env.setAttack(0.01);
    env.setDecay(0.01);
    env.setSustain(0.5);
    env.trigger(0, 0.4);
    env.rescale(1, 0.8, 0.05);
    expect(gain.setTargetAtTime).toHaveBeenLastCalledWith(0.4, 1, 0.05);
  });

  it('never cuts a running decay short: the slower time constant wins', () => {
    const { env, gain } = build();
    env.setAttack(0.01);
    env.setDecay(0.9); // tau 0.3, still running at t = 0.2
    env.setSustain(0.5);
    env.trigger(0, 1);
    env.rescale(0.2, 0.5, 0.01);
    expect(gain.setTargetAtTime).toHaveBeenLastCalledWith(0.25, 0.2, 0.3);
  });

  it('in the attack, aims the attack at the new peak and keeps its end (edge)', () => {
    const { env, gain } = build();
    env.setAttack(0.3); // tau 0.1; ends at 1.3
    env.setDecay(0.6);  // tau 0.2
    env.setSustain(0.5);
    env.trigger(1, 0.2);
    gain.setTargetAtTime.mockClear();
    env.rescale(1.1, 0.8, 0.05);
    const calls = gain.setTargetAtTime.mock.calls as [number, number, number][];
    expect(calls).toHaveLength(2);
    const want = [[0.8, 1.1, 0.1], [0.4, 1.3, 0.2]];
    calls.forEach((c, i) => c.forEach((x, j) => expect(x).toBeCloseTo(want[i]![j]!, 9)));
  });

  it('schedules nothing at an unchanged peak', () => {
    const { env, gain } = build();
    env.setSustain(1);
    env.trigger(0, 0.5);
    gain.setValueAtTime.mockClear();
    gain.setTargetAtTime.mockClear();
    gain.cancelScheduledValues.mockClear();
    env.rescale(1, 0.5, 0.05);
    expect(gain.setValueAtTime).not.toHaveBeenCalled();
    expect(gain.setTargetAtTime).not.toHaveBeenCalled();
    expect(gain.cancelScheduledValues).not.toHaveBeenCalled();
  });

  it('is future-time-safe: anchors the value the curve reaches, not the live value', () => {
    const { env, gain } = build();
    env.setAttack(0.01);
    env.setDecay(0.01);
    env.setSustain(1);
    env.trigger(0.1, 0.3); // the note has not sounded yet: gain.value is still 0
    env.rescale(0.4, 0.5, 0.05);
    const [v, t] = lastAnchor(gain);
    expect(t).toBe(0.4);
    expect(v).toBeCloseTo(0.3, 3);
  });
});
