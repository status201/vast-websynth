import type { Arrangement } from '../../src/audio/transport/arrangement';

/**
 * A minimal stand-in for `Arrangement` — only the surface `Song.capture` and
 * `Song.apply` touch (the four lanes and the four `set*Chain` setters).
 *
 * **One copy, deliberately.** Five test files each carried their own near-identical
 * literal, every one cast `as never` so the compiler could not tell them when the
 * real `Arrangement` grew. Adding `ChainLane.transpose` broke 82 tests across all
 * five at once, none of which was testing arrangement plumbing — the duplication
 * was the defect, not the field. This is now the only place that has to learn
 * about a new lane field.
 *
 * The setters mirror the real ones closely enough for the round-trip tests:
 * `transpose` is resized to the chain and defaults to all-zeros, which is what
 * `Arrangement.fitTranspose` guarantees.
 */
export interface FakeLane {
  enabled: boolean;
  steps: number[];
  transpose: number[];
}

export interface FakeArrangement {
  seq: FakeLane;
  drum: FakeLane;
  sampler: FakeLane;
  motion: FakeLane;
  setSeqChain(steps: number[], enabled: boolean, transpose?: number[]): void;
  setDrumChain(steps: number[], enabled: boolean): void;
  setSamplerChain(steps: number[], enabled: boolean): void;
  setMotionChain(steps: number[], enabled: boolean): void;
}

const lane = (steps: number[] = [0], transpose: number[] = []): FakeLane => ({
  enabled: false,
  steps: [...steps],
  // Same invariant as the real lane: exactly as long as `steps`, zero-padded.
  transpose: steps.map((_, i) => transpose[i] ?? 0),
});

export function fakeArrangement(): FakeArrangement {
  return {
    seq: lane(),
    drum: lane(),
    sampler: lane(),
    motion: lane(),
    setSeqChain(steps, enabled, transpose) {
      this.seq = { ...lane(steps, transpose ?? []), enabled };
    },
    setDrumChain(steps, enabled) { this.drum = { ...lane(steps), enabled }; },
    setSamplerChain(steps, enabled) { this.sampler = { ...lane(steps), enabled }; },
    setMotionChain(steps, enabled) { this.motion = { ...lane(steps), enabled }; },
  };
}

/**
 * The same fake, typed as the real `Arrangement` for the `Song.capture` /
 * `Song.apply` parameter. Replaces the `as never` each call site used to write —
 * `as never` silences the compiler for *any* mismatch, which is precisely how
 * the drift above went unnoticed.
 */
export const fakeArr = (): Arrangement => fakeArrangement() as unknown as Arrangement;
