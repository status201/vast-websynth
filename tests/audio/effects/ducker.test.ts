import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Ducker, envValueAt, DUCK_SRC_ANY } from '../../../src/audio/effects/ducker';
import { makeMockAudioContext, type MockAudioParam } from '../mock-audio-context';

/**
 * Trigger-keyed sidechain ducking (sidechain-ducking.md). The DSP is native
 * `AudioParam` automation, so what there is to test is *what gets scheduled* —
 * which is exactly what the mock records.
 */
describe('Ducker', () => {
  // The wrapper schedules a disconnect on construction (ADR-012); fake timers
  // keep that off the real event loop.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function build(opts: { on?: boolean; src?: number; attack?: number; release?: number } = {}) {
    const ctx = makeMockAudioContext();
    const duck = new Ducker(ctx as unknown as AudioContext);
    duck.setBypass(!(opts.on ?? true));
    duck.setSrc(opts.src ?? 0);
    duck.setAttack(opts.attack ?? 0.005);
    duck.setRelease(opts.release ?? 0.18);
    // The ConstantSourceNode is the only one built with an `offset`.
    const created = ctx.createConstantSource.mock.results.map((r) => r.value as { offset: MockAudioParam });
    return { duck, env: created[0]!.offset };
  }

  describe('scheduling (REQ-1, REQ-3)', () => {
    it('ramps down then decays back on a key hit', () => {
      const { duck, env } = build({ src: 0, attack: 0.005, release: 0.18 });
      duck.onDrumHit(0, 10);

      expect(env.cancelScheduledValues).toHaveBeenCalledWith(10);
      expect(env.setValueAtTime).toHaveBeenCalledWith(0, 10); // first hit: from rest
      expect(env.linearRampToValueAtTime).toHaveBeenCalledWith(1, 10.005);
      // Always last: the terminal state is a decay to *no duck* (REQ-5).
      expect(env.setTargetAtTime).toHaveBeenCalledWith(0, 10.005, 0.18);
    });

    it('does not duck on a non-key track (REQ-7)', () => {
      const { duck, env } = build({ src: 0 });
      duck.onDrumHit(3, 10);
      expect(env.setValueAtTime).not.toHaveBeenCalled();
      expect(env.cancelScheduledValues).not.toHaveBeenCalled();
    });

    it('ducks on every track when src is Any (REQ-7)', () => {
      const { duck, env } = build({ src: DUCK_SRC_ANY });
      duck.onDrumHit(5, 10);
      expect(env.linearRampToValueAtTime).toHaveBeenCalledWith(1, 10.005);
    });

    it('schedules nothing while bypassed (REQ-6)', () => {
      const { duck, env } = build({ on: false, src: 0 });
      duck.onDrumHit(0, 10);
      expect(env.cancelScheduledValues).not.toHaveBeenCalled();
      expect(env.setValueAtTime).not.toHaveBeenCalled();
    });
  });

  /**
   * `forEachActiveHit` sweeps lanes outer, ratchets inner, so an earlier lane's
   * hit can arrive *after* a later ratchet sub-hit. Cancelling for the earlier
   * time would erase the ramp already scheduled for the later one and strand the
   * envelope mid-duck — the one way this design could get stuck ducked.
   */
  describe('out-of-order triggers (REQ-4)', () => {
    it('ignores a hit earlier than the last scheduled onset', () => {
      const { duck, env } = build({ src: DUCK_SRC_ANY });
      duck.onDrumHit(0, 10.5); // a ratchet sub-hit, emitted first
      env.cancelScheduledValues.mockClear();
      env.setValueAtTime.mockClear();
      env.linearRampToValueAtTime.mockClear();

      duck.onDrumHit(3, 10.0); // an earlier lane, emitted second

      expect(env.cancelScheduledValues).not.toHaveBeenCalled();
      expect(env.setValueAtTime).not.toHaveBeenCalled();
      expect(env.linearRampToValueAtTime).not.toHaveBeenCalled();
    });

    it('still accepts a later hit after ignoring an earlier one', () => {
      const { duck, env } = build({ src: DUCK_SRC_ANY });
      duck.onDrumHit(0, 10.5);
      duck.onDrumHit(3, 10.0); // ignored
      duck.onDrumHit(0, 11.0);
      expect(env.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 11.005);
    });
  });

  /**
   * A retrigger pins the envelope's current value before ramping again, because
   * `cancelScheduledValues` alone can snap the param back to the cancelled
   * ramp's start — and `cancelAndHoldAtTime`, which would avoid that, is not
   * implemented in Firefox.
   */
  describe('retrigger (REQ-3)', () => {
    it('pins the mid-decay value rather than restarting from rest', () => {
      const { duck, env } = build({ src: 0, attack: 0.005, release: 0.18 });
      duck.onDrumHit(0, 10);
      env.setValueAtTime.mockClear();

      duck.onDrumHit(0, 10.1); // ~0.095s into the decay
      const pinned = env.setValueAtTime.mock.calls[0]![0] as number;
      expect(pinned).toBeCloseTo(Math.exp(-0.095 / 0.18), 6);
      expect(pinned).toBeGreaterThan(0);
      expect(pinned).toBeLessThan(1);
    });
  });

  describe('envValueAt', () => {
    it('is 0 before any hit (onset -Infinity)', () => {
      expect(envValueAt(0, -Infinity, 0, 0.005, 0.18)).toBe(0);
    });

    it('interpolates linearly across the attack', () => {
      expect(envValueAt(10, 10, 0, 0.01, 0.18)).toBe(0);
      expect(envValueAt(10.005, 10, 0, 0.01, 0.18)).toBeCloseTo(0.5, 10);
      expect(envValueAt(10.01, 10, 0, 0.01, 0.18)).toBeCloseTo(1, 10);
    });

    it('interpolates from a non-zero start (a retrigger mid-duck)', () => {
      expect(envValueAt(10.005, 10, 0.4, 0.01, 0.18)).toBeCloseTo(0.7, 10);
    });

    it('decays exponentially after the attack', () => {
      expect(envValueAt(10.01, 10, 0, 0.01, 0.18)).toBeCloseTo(1, 10);
      expect(envValueAt(10.19, 10, 0, 0.01, 0.18)).toBeCloseTo(Math.exp(-1), 10);
    });

    /**
     * REQ-2's bound: gain is `1 - amount * e`, so `e` leaving [0,1] would put
     * the bus gain outside [0,1]. Swept rather than spot-checked because the
     * whole stability claim rests on it.
     */
    it('stays within [0,1] across the whole timeline, from any start value', () => {
      for (const startVal of [0, 0.3, 1]) {
        for (let t = 9.9; t < 12; t += 0.001) {
          const v = envValueAt(t, 10, startVal, 0.005, 0.18);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  /**
   * Nothing releases the envelope explicitly: every schedule *ends* with a decay
   * to 0, so a stop, a clock dropout and a bypass all recover unaided.
   */
  it('leaves a decay to rest as the final scheduled event (REQ-5)', () => {
    const { duck, env } = build({ src: 0 });
    duck.onDrumHit(0, 10);

    const lastDecay = env.setTargetAtTime.mock.calls.at(-1)!;
    expect(lastDecay[0]).toBe(0); // target = no duck
    // Nothing is scheduled after it, so a transport that stops here still recovers.
    const lastRamp = env.linearRampToValueAtTime.mock.calls.at(-1)!;
    expect(lastDecay[1] as number).toBeGreaterThanOrEqual(lastRamp[1] as number);
  });

  it('has no setMix — the ducker has no dry/wet (effects.md REQ-1)', () => {
    const { duck } = build();
    expect((duck as unknown as { setMix?: unknown }).setMix).toBeUndefined();
  });
});
