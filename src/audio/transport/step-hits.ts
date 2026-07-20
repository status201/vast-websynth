import type { StepSettings, TriggerCell } from '../../state/patterns';

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

/**
 * The one-shot machines' per-tick lane sweep (drum tracks / sampler slots):
 * for each unmuted lane whose cell at `idx` is on and passes its probability
 * roll, expand the ratchet sub-hits and hand each to `fire`. Shared so the
 * drum machine and the sampler can never drift on mute/prob/ratchet semantics.
 *
 * `fire` receives the lane index, the sub-hit and the cell, so the caller keeps
 * ownership of what a hit *does* (a drum voice trigger vs a buffer playback).
 *
 * `muted.length` is the lane count (it is sized to DRUM_TRACK_COUNT /
 * SAMPLER_SLOT_COUNT), so a short bank contributes nothing and a bank with
 * extra rows is ignored — exactly the fixed-count loops this replaced.
 */
export function forEachActiveHit(
  bank: readonly (readonly TriggerCell[])[],
  idx: number,
  when: number,
  stepDur: number,
  muted: readonly boolean[],
  fire: (lane: number, hit: StepHit, cell: TriggerCell) => void,
): void {
  for (let lane = 0; lane < muted.length; lane++) {
    if (muted[lane]) continue;
    const cell = bank[lane]?.[idx];
    if (!cell || !cell.on || !rollProb(cell.prob)) continue;
    for (const h of stepHits(cell, when, stepDur)) fire(lane, h, cell);
  }
}
