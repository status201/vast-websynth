import { Arrangement } from '../../../src/audio/transport/arrangement';
import type { Performance } from '../../../src/audio/transport/performance';
import { PatternStore, SEQ_LENGTH } from '../../../src/state/patterns';
import { cellIndex, DEFAULT_LANE_RATE } from '../../../src/state/meter';
import { TestClock } from './test-clock';

/**
 * Shared rig for the transport-machine suites.
 *
 * A real `Performance` needs an AudioContext (it owns the DJ filter), so the
 * machines get a stub exposing only what they actually read: `mapStep` /
 * `stepIndex` (the stutter remap), plus `fillActive` / `setFill` for the drum
 * machine's fill. `stepIndex` is derived from *this stub's* `mapStep`, so a
 * test that injects a custom remap gets a consistent bank index too.
 */
export function createPerfStub(
  mapStep: (s: number) => number = (s) => s,
): Performance & { fillActive: boolean } {
  return {
    mapStep,
    stepIndex: (s: number, cells = SEQ_LENGTH, rate = DEFAULT_LANE_RATE) =>
      cellIndex(mapStep(s), cells, rate),
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
