import { describe, it, expect } from 'vitest';
import { Envelope } from '../../src/audio/envelope';
import { makeMockAudioContext } from './mock-audio-context';
import type { MockAudioParam } from './mock-audio-context';

/**
 * Scheduled-automation model (envelopes.md REQ-4): phase changes anchor at the
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
