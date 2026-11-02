import { describe, it, expect } from 'vitest';
import {
  adsrCurve,
  approach,
  phaseTau,
  PHASE_TIME_CONSTANTS,
} from '../../src/utils/envelope-curve';
import { Envelope } from '../../src/audio/envelope';
import { makeMockAudioContext, type MockAudioParam } from '../audio/mock-audio-context';

/** The pure ADSR model shared by Envelope and the help graph
 *  (envelopes.md REQ-the-envelope-curve-is-one-pure-model, envelope-help-graph.md). */

const ENV = { attack: 0.3, decay: 0.5, sustain: 0.4, release: 0.6 };

/** The sample nearest time t. */
const at = (pts: { t: number; v: number }[], t: number) =>
  pts.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best));

describe('envelope-curve', () => {
  it('approach is the setTargetAtTime closed form', () => {
    expect(approach(0, 1, 0, 0.1)).toBe(0);
    expect(approach(0, 1, 0.1, 0.1)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(approach(1, 0.25, 0.2, 0.1)).toBeCloseTo(0.25 + 0.75 * Math.exp(-2), 12);
  });

  it('a phase is three time constants', () => {
    expect(PHASE_TIME_CONSTANTS).toBe(3);
    expect(phaseTau(0.3)).toBe(0.3 / 3);
  });

  it('reaches 1 − e⁻³ at the end of the attack, then settles toward sustain', () => {
    const c = adsrCurve(ENV, 2);
    expect(at(c.points, ENV.attack).v).toBeCloseTo(1 - Math.exp(-3), 9);
    // The hold plateau ends close to the sustain level.
    expect(at(c.points, c.keyUp).v).toBeCloseTo(ENV.sustain, 2);
    // The release falls toward 0: at its span's end ~e⁻³ of where it started.
    const last = c.points.at(-1)!;
    expect(last.t).toBeCloseTo(c.end, 12);
    expect(last.v).toBeCloseTo(at(c.points, c.keyUp).v * Math.exp(-3), 9);
  });

  it('places the phase boundaries on samples, in order', () => {
    const c = adsrCurve(ENV, 1, 8);
    expect(c.decayEnd).toBeCloseTo(ENV.attack + ENV.decay, 12);
    expect(c.keyUp).toBeCloseTo(c.decayEnd + 1, 12);
    expect(c.end).toBeCloseTo(c.keyUp + ENV.release, 12);
    for (const t of [0, ENV.attack, c.decayEnd, c.keyUp, c.end]) {
      expect(c.points.some((p) => Math.abs(p.t - t) < 1e-12), `sample at ${t}`).toBe(true);
    }
    for (let i = 1; i < c.points.length; i++) {
      expect(c.points[i]!.t).toBeGreaterThan(c.points[i - 1]!.t);
    }
  });

  it('agrees with the value Envelope anchors its release at', () => {
    const ctx = makeMockAudioContext();
    const env = new Envelope(ctx as unknown as AudioContext);
    const gain = env.out.gain as unknown as MockAudioParam;
    env.setAttack(ENV.attack);
    env.setDecay(ENV.decay);
    env.setSustain(ENV.sustain);
    env.setRelease(ENV.release);
    const hold = 0.2;
    const c = adsrCurve(ENV, hold);
    env.trigger(0, 1);
    env.release_(c.keyUp);
    const [v, t] = gain.setValueAtTime.mock.calls.at(-1) as [number, number];
    expect(t).toBe(c.keyUp);
    expect(v).toBeCloseTo(at(c.points, c.keyUp).v, 12);
  });
});
