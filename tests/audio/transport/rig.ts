import { Arrangement } from '../../../src/audio/transport/arrangement';
import type { Performance } from '../../../src/audio/transport/performance';
import { PatternStore } from '../../../src/state/patterns';
import { TestClock } from './test-clock';

/**
 * Shared rig for the transport-machine suites.
 *
 * A real `Performance` needs an AudioContext (it owns the DJ filter), so the
 * machines get a stub exposing only what they actually read: `mapStep` (the
 * stutter remap, which each machine's `LaneMeter` folds into a cell), plus
 * `fillActive` / `setFill` for the drum machine's fill.
 */
export function createPerfStub(
  mapStep: (s: number) => number = (s) => s,
): Performance & { fillActive: boolean } {
  return {
    mapStep,
    fillActive: false,
    setFill() {},
  } as unknown as Performance & { fillActive: boolean };
}

/**
 * The clock/patterns/arrangement/perf quartet every machine is constructed
 * against. The `Arrangement` must be built before the machine so its
 * `clock.onTick` runs first and play banks are settled when the machine reads
 * them on the same tick — the same ordering `Engine` uses.
 */
export function makeTransportRig(perf = createPerfStub()): {
  clock: TestClock;
  patterns: PatternStore;
  arrangement: Arrangement;
  perf: Performance & { fillActive: boolean };
} {
  const clock = new TestClock();
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, clock);
  return { clock, patterns, arrangement, perf };
}
