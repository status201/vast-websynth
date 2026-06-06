import { describe, it, expect, vi } from 'vitest';
import { DrumMachine } from '../../../src/audio/transport/drum-machine';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import type { Performance } from '../../../src/audio/transport/performance';
import { PatternStore } from '../../../src/state/patterns';
import { TestClock } from './test-clock';
import { makeMockAudioContext } from '../mock-audio-context';

/** Mutable Performance-like stub (DrumMachine only reads mapStep + fillActive). */
function perfStub(mapStep: (s: number) => number = (s) => s) {
  return { mapStep, fillActive: false, setFill() {} } as unknown as Performance & { fillActive: boolean };
}

function build(perf = perfStub()) {
  const ctx = makeMockAudioContext();
  const clock = new TestClock();
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, clock);
  const drumBus = (ctx as unknown as AudioContext).createGain();
  const dm = new DrumMachine(
    ctx as unknown as AudioContext,
    clock,
    patterns,
    arrangement,
    perf as unknown as Performance,
    drumBus,
  );
  // Edit bank B (index 1) is empty — avoids the default groove seeded in bank A.
  patterns.setDrumEditBank(1);
  const spies = dm.tracks.map((t) => vi.spyOn(t, 'trigger'));
  return { ctx, clock, patterns, arrangement, perf, dm, spies };
}

describe('DrumMachine', () => {
  it('does not trigger anything while disabled', () => {
    const { clock, patterns, spies } = build();
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7 });
    clock.fireTick(0);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('fires only the active cells of the play bank, with the cell velocity', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.7 }); // kick on step 0
    clock.fireTick(0);
    expect(spies[0]).toHaveBeenCalledWith(0, 0.7);
    expect(spies[1]).not.toHaveBeenCalled();
  });

  it('skips a muted track', () => {
    const { clock, patterns, dm, spies } = build();
    dm.setEnabled(true);
    patterns.setDrumCell(2, 0, { on: true, velocity: 0.9 });
    dm.setTrackMute(2, true);
    clock.fireTick(0);
    expect(spies[2]).not.toHaveBeenCalled();
  });

  it('reads the bank at the stutter-mapped step', () => {
    const { clock, patterns, dm, spies } = build(perfStub(() => 4));
    dm.setEnabled(true);
    patterns.setDrumCell(0, 4, { on: true, velocity: 0.8 }); // cell at the mapped index
    patterns.setDrumCell(0, 0, { on: true, velocity: 0.3 }); // raw step (should be ignored)
    clock.fireTick(0); // raw step 0 → mapStep → 4
    expect(spies[0]).toHaveBeenCalledTimes(1);
    expect(spies[0]).toHaveBeenCalledWith(0, 0.8);
  });

  it('plays the fill cascade instead of the pattern when fillActive', () => {
    const perf = perfStub();
    const { clock, patterns, dm, spies } = build(perf);
    dm.setEnabled(true);
    perf.fillActive = true;
    // A pattern cell that must NOT fire while the fill owns the step.
    patterns.setDrumCell(1, 0, { on: true, velocity: 0.9 });

    clock.step = 0; clock.fireTick(0);
    expect(spies[0]).toHaveBeenCalled(); // kick anchor on step 0

    clock.step = 12; clock.fireTick(0);
    expect(spies[4]).toHaveBeenCalled(); // low tom starts the roll at step 12

    clock.step = 15; clock.fireTick(0);
    expect(spies[6]).toHaveBeenCalled(); // high tom
    expect(spies[7]).toHaveBeenCalled(); // clap accent
  });

  it('notifies step listeners with the mapped index', () => {
    const { clock, dm } = build();
    dm.setEnabled(true);
    const steps: number[] = [];
    dm.onStep((s) => steps.push(s));
    clock.fireTicks(3);
    expect(steps).toEqual([0, 1, 2]);
  });
});
