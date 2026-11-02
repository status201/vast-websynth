/**
 * The ADSR curve as pure math (envelopes.md REQ-the-envelope-curve-is-one-pure-model).
 *
 * Every envelope phase is a `setTargetAtTime` exponential whose time constant is
 * a third of the phase's knob time, so the knob reads as "time to ~95% of the
 * way" (1 − e⁻³). `Envelope` schedules with these functions and the help graph
 * (envelope-help-graph.md) draws with them, so the picture and the sound share
 * one formula.
 */

/** The shortest a timed phase may be: a zero time constant would divide by zero. */
export const MIN_PHASE_SECONDS = 0.001;

/** How many time constants fit in a phase's knob time (3 → ~95% of the way). */
export const PHASE_TIME_CONSTANTS = 3;

/** The `setTargetAtTime` time constant for a phase lasting `seconds`. */
export function phaseTau(seconds: number): number {
  return seconds / PHASE_TIME_CONSTANTS;
}

/** Where a `setTargetAtTime` segment from `v0` toward `target` is after `dt` s. */
export function approach(v0: number, target: number, dt: number, tau: number): number {
  return target + (v0 - target) * Math.exp(-dt / tau);
}

export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export interface AdsrCurve {
  /** Sampled curve; `t` is seconds from key down, `v` in [0, 1]. */
  points: { t: number; v: number }[];
  /** Where the attack ends and the decay starts. */
  attackEnd: number;
  /** Where the decay knob's span ends (`attack + decay`). */
  decayEnd: number;
  /** Where the key is let go and the release starts. */
  keyUp: number;
  /** The release knob's span end (`keyUp + release`). */
  end: number;
}

/**
 * Sample a full note at peak 1: attack and decay from key down, the decay's
 * approach continuing for `holdSeconds` past the decay span, then the release.
 * Each phase gets `samplesPerPhase` points including both ends, so a phase
 * boundary is always a sample.
 */
export function adsrCurve(env: Adsr, holdSeconds: number, samplesPerPhase = 24): AdsrCurve {
  const a = Math.max(MIN_PHASE_SECONDS, env.attack);
  const d = Math.max(MIN_PHASE_SECONDS, env.decay);
  const r = Math.max(MIN_PHASE_SECONDS, env.release);
  const s = Math.min(1, Math.max(0, env.sustain));
  const decayEnd = a + d;
  const keyUp = decayEnd + Math.max(0, holdSeconds);
  const end = keyUp + r;

  const atkTau = phaseTau(a);
  const decTau = phaseTau(d);
  const relTau = phaseTau(r);
  const atkTop = approach(0, 1, a, atkTau);
  const atKeyUp = approach(atkTop, s, keyUp - a, decTau);

  const value = (t: number): number => {
    if (t <= a) return approach(0, 1, t, atkTau);
    if (t <= keyUp) return approach(atkTop, s, t - a, decTau);
    return approach(atKeyUp, 0, t - keyUp, relTau);
  };

  const n = Math.max(2, Math.floor(samplesPerPhase));
  const points: { t: number; v: number }[] = [];
  const span = (from: number, to: number, first: boolean): void => {
    for (let i = first ? 0 : 1; i < n; i++) {
      const t = from + ((to - from) * i) / (n - 1);
      points.push({ t, v: value(t) });
    }
  };
  span(0, a, true);
  span(a, decayEnd, false);
  if (keyUp > decayEnd) span(decayEnd, keyUp, false);
  span(keyUp, end, false);
  return { points, attackEnd: a, decayEnd, keyUp, end };
}
