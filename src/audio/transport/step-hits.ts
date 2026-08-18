import type { StepSettings, TriggerCell } from '../../state/patterns';
import { MICRO_UNITS } from '../../state/limits';

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
 * How far an *early* nudge may reach, in seconds (step-settings.md REQ-9).
 *
 * The clock emits a tick at most `SCHEDULE_AHEAD_S` (0.1 s) ahead and re-wakes
 * every `LOOKAHEAD_MS` (25 ms), so the guaranteed lead on any tick is ~75 ms.
 * Reaching past that schedules into the past, where the `Math.max(when,
 * currentTime)` clamps in the drum voices and the sampler bunch hits onto *now* —
 * the burst shape transport.md REQ-9 exists to prevent. 60 ms keeps 15 ms of
 * margin for timer jitter.
 *
 * Late offsets need no cap: a later time is always schedulable.
 */
export const MAX_EARLY_S = 0.06;

/**
 * The step's micro-timing offset in seconds — negative early, positive late
 * (step-settings.md REQ-6/REQ-8). One definition, the way `Clock.swingOffset` is
 * one definition of swing.
 *
 * `cellDur` is the **lane's** cell, not the clock's 16th, so a lane running at
 * 1/8 nudges in 1/24 of its own longer cell and the notch stays a constant
 * fraction of what the user sees on the grid (meter.md REQ-14).
 *
 * `micro === 0` returns before any arithmetic: the overwhelmingly common case
 * costs one property read and one branch (ADR-010 — cheap).
 */
export function microOffset(s: Pick<StepSettings, 'micro'>, cellDur: number): number {
  if (!s.micro) return 0;
  const off = (s.micro / MICRO_UNITS) * cellDur;
  return off < 0 ? Math.max(off, -MAX_EARLY_S) : off;
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
    // Per *cell*, inside the lane loop — each lane nudges independently, which is
    // the whole point of micro-timing (step-settings.md REQ-8). Offsetting the
    // shared `when` outside the loop would move the entire tick instead.
    const at = when + microOffset(cell, stepDur);
    for (const h of stepHits(cell, at, stepDur)) fire(lane, h, cell);
  }
}
