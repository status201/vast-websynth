import type { StepSettings } from '../../state/patterns';

/**
 * Pure per-step hit math shared by the sequencer, drum machine and sampler:
 * the probability roll and the ratchet sub-hit timing. AudioContext-free so
 * it is unit-testable; each machine interprets the hits itself (the seq
 * releases its voice at `gateEnd`, the one-shot machines choke there).
 */
export interface StepHit {
  t: number;        // audio time the sub-hit sounds
  gateEnd: number;  // t + sub-duration * gate
  holds: boolean;   // tie && last sub-hit — hold past the gate into the next step
}

/** True when the step fires this pass (prob 1 = always; rng injectable for tests). */
export function rollProb(prob: number, rng: () => number = Math.random): boolean {
  return !(prob < 1 && rng() > prob);
}

/** The 1..4 evenly-spaced ratchet sub-hits across one step. */
export function stepHits(
  s: Pick<StepSettings, 'gate' | 'ratchet' | 'tie'>,
  when: number,
  stepDur: number,
): StepHit[] {
  const ratchet = Math.max(1, Math.round(s.ratchet));
  const sub = stepDur / ratchet;
  return Array.from({ length: ratchet }, (_, r) => {
    const t = when + r * sub;
    return { t, gateEnd: t + sub * s.gate, holds: s.tie && r === ratchet - 1 };
  });
}

/**
 * Choke-model cut time for one-shot hits: cut at `gateEnd` when the gate is
 * shortened, unless the hit holds (tie). gate 1 = natural decay, no cut.
 */
export function chokeAt(s: Pick<StepSettings, 'gate'>, hit: StepHit): number | undefined {
  return s.gate < 1 && !hit.holds ? hit.gateEnd : undefined;
}
