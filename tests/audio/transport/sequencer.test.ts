import { describe, it, expect, vi } from 'vitest';
import { PatternStore, SEQ_LENGTH } from '../../../src/state/patterns';
import { StepSequencer } from '../../../src/audio/transport/sequencer';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import { Performance } from '../../../src/audio/transport/performance';
import { TestClock } from './test-clock';
import type { SynthOutput } from '../../../src/audio/transport/note-output';

/**
 * Minimal Performance-like stub that Performance needs (ctx, djFilter).
 * We avoid constructing a real Performance since it needs AudioContext.
 */
function createPerfStub() {
  return {
    mapStep: (s: number) => s,
    fillActive: false,
    setFill: () => {},
  } as unknown as Performance;
}

describe('StepSequencer', () => {
  it('plays notes from the pattern on each tick', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arrangement = new Arrangement(patterns, clock);
    const perf = createPerfStub();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    // Enable and set a note on step 0
    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });

    clock.fireTick(0); // step 0 → should trigger note 60
    expect(playNote).toHaveBeenCalledWith(60, 0.8, 0);
    // gate 0.5 of one 16th (60/120/4 = 0.125s) → 0.0625s
    expect(releaseNote).toHaveBeenCalledWith(60, 0.0625);
  });

  it('skips inactive steps', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arrangement = new Arrangement(patterns, clock);
    const perf = createPerfStub();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);

    // All steps are off by default
    clock.fireTick(0);
    expect(playNote).not.toHaveBeenCalled();
  });

  it('releases the previous note before playing the next', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arrangement = new Arrangement(patterns, clock);
    const perf = createPerfStub();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });
    patterns.setSeqStep(1, { on: true, note: 64, velocity: 0.7, gate: 0.5 });

    clock.fireTick(0); // plays note 60 (released at 0 + 0.125*0.5 = 0.0625)
    clock.fireTick(0.125); // when = 0.125 → release 60, then play 64
    expect(releaseNote).toHaveBeenCalledWith(60, 0.125);
    expect(playNote).toHaveBeenCalledWith(64, 0.7, 0.125);
  });

  it('does nothing when disabled', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arrangement = new Arrangement(patterns, clock);
    const perf = createPerfStub();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    // Not enabled
    patterns.setSeqStep(0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });
    clock.fireTick(0);
    expect(playNote).not.toHaveBeenCalled();
  });

  it('disabling during playback releases the held note', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arrangement = new Arrangement(patterns, clock);
    const perf = createPerfStub();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });
    clock.fireTick(0);
    expect(playNote).toHaveBeenCalledOnce();

    seq.setEnabled(false);
    expect(releaseNote).toHaveBeenCalledWith(60, expect.any(Number));
  });

  it('fires step listeners with the mapped step index', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arrangement = new Arrangement(patterns, clock);
    const perf = createPerfStub();
    const output: SynthOutput = { playNote: vi.fn(), releaseNote: vi.fn() };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    const steps: number[] = [];
    seq.onStep((s) => steps.push(s));

    clock.fireTicks(3);
    expect(steps).toEqual([0, 1, 2]);
  });

  it('fires note listeners with note/when/releaseAt', () => {
    const clock = new TestClock();
    const patterns = new PatternStore();
    const arrangement = new Arrangement(patterns, clock);
    const perf = createPerfStub();
    const output: SynthOutput = { playNote: vi.fn(), releaseNote: vi.fn() };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, { on: true, note: 72, velocity: 0.9, gate: 0.25 });

    const notes: Array<[number, number, number]> = [];
    seq.onNote((n, w, r) => notes.push([n, w, r]));

    clock.fireTick(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]![0]).toBe(72);
    expect(notes[0]![1]).toBe(0);
    expect(notes[0]![2]).toBeCloseTo(0.03125, 5); // 0.125 * 0.25
  });
});
