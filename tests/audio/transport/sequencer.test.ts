import { describe, it, expect, vi } from 'vitest';
import { StepSequencer } from '../../../src/audio/transport/sequencer';
import type { SynthOutput } from '../../../src/audio/transport/note-output';
import { makeTransportRig } from './rig';

describe('StepSequencer', () => {
  it('plays notes from the pattern on each tick', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    // Enable and set a note on step 0
    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });

    clock.fireTick(0); // step 0 → should trigger note 60
    expect(playNote).toHaveBeenCalledWith(60, 0.8, 0);
    // gate 0.5 of one 16th (60/120/4 = 0.125s) → 0.0625s
    expect(releaseNote).toHaveBeenCalledWith(60, 0.0625);
  });

  it('skips inactive steps', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
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
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });
    patterns.setSeqStep(0, 1, { on: true, note: 64, velocity: 0.7, gate: 0.5 });

    clock.fireTick(0); // plays note 60 (released at 0 + 0.125*0.5 = 0.0625)
    clock.fireTick(0.125); // when = 0.125 → release 60, then play 64
    expect(releaseNote).toHaveBeenCalledWith(60, 0.125);
    expect(playNote).toHaveBeenCalledWith(64, 0.7, 0.125);
  });

  it('does nothing when disabled', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    // Not enabled
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });
    clock.fireTick(0);
    expect(playNote).not.toHaveBeenCalled();
  });

  it('disabling during playback releases the held note', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });
    clock.fireTick(0);
    expect(playNote).toHaveBeenCalledOnce();

    seq.setEnabled(false);
    expect(releaseNote).toHaveBeenCalledWith(60, expect.any(Number));
  });

  it('fires step listeners with the mapped step index', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const output: SynthOutput = { playNote: vi.fn(), releaseNote: vi.fn() };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    const steps: number[] = [];
    seq.onStep((s) => steps.push(s));

    clock.fireTicks(3);
    expect(steps).toEqual([0, 1, 2]);
  });

  it('skips a step when probability loses the dice roll', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote: vi.fn() };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, prob: 0.5 });
    patterns.setSeqStep(0, 1, { on: true, note: 60, prob: 0.5 });

    const rng = vi.spyOn(Math, 'random');
    rng.mockReturnValue(0.9); // 0.9 > 0.5 → rest
    clock.fireTick(0); // step 0
    expect(playNote).not.toHaveBeenCalled();

    rng.mockReturnValue(0.1); // 0.1 <= 0.5 → fire
    clock.fireTick(0.125); // step 1
    expect(playNote).toHaveBeenCalledWith(60, expect.any(Number), 0.125);
    rng.mockRestore();
  });

  it('ratchet schedules N evenly-spaced sub-hits within the step', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote: vi.fn() };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, gate: 0.5, ratchet: 3 });

    clock.fireTick(0);
    expect(playNote).toHaveBeenCalledTimes(3);
    const sub = 0.125 / 3; // one 16th split three ways
    expect(playNote).toHaveBeenNthCalledWith(1, 60, expect.any(Number), 0);
    expect(playNote).toHaveBeenNthCalledWith(2, 60, expect.any(Number), sub);
    expect(playNote).toHaveBeenNthCalledWith(3, 60, expect.any(Number), 2 * sub);
  });

  it('tie holds into the next step instead of releasing first (legato)', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, gate: 0.5, tie: true });
    patterns.setSeqStep(0, 1, { on: true, note: 64, gate: 0.5 });

    clock.fireTick(0); // tied step: plays 60 but schedules no release
    expect(playNote).toHaveBeenCalledWith(60, expect.any(Number), 0);
    expect(releaseNote).not.toHaveBeenCalled();

    clock.fireTick(0.125); // next step attacks without first releasing the tied note
    expect(releaseNote).not.toHaveBeenCalledWith(60, 0.125);
    expect(playNote).toHaveBeenCalledWith(64, expect.any(Number), 0.125);
  });

  it('a tie into a rest releases the held note rather than ringing forever', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote: vi.fn(), releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, tie: true }); // step 1 stays off (rest)

    clock.fireTick(0);
    clock.fireTick(0.125); // rest after a tie → release the held note here
    expect(releaseNote).toHaveBeenCalledWith(60, 0.125);
  });

  it('fires note listeners with note/when/releaseAt', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const output: SynthOutput = { playNote: vi.fn(), releaseNote: vi.fn() };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 72, velocity: 0.9, gate: 0.25 });

    const notes: Array<[number, number, number]> = [];
    seq.onNote((n, w, r) => notes.push([n, w, r]));

    clock.fireTick(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]![0]).toBe(72);
    expect(notes[0]![1]).toBe(0);
    expect(notes[0]![2]).toBeCloseTo(0.03125, 5); // 0.125 * 0.25
  });

  it('plays nothing during an arrangement rest bar', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote: vi.fn() };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    // A lit step in the play bank, but the only chain slot is a rest.
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8 });
    arrangement.setSeqChain([-1], true); // REST

    clock.fireStart();
    clock.fireTick(0); // bar boundary → arrangement resting → seq skips
    expect(arrangement.seqResting).toBe(true);
    expect(playNote).not.toHaveBeenCalled();
  });
});

describe('StepSequencer — four tracks (sequencer.md REQ-8/REQ-9/REQ-10)', () => {
  /** Rig with recording output stubs — the four-track cases care about the SET
   *  of notes per tick, which vi.fn() call order alone makes awkward to read. */
  function build() {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const played: { note: number; when: number }[] = [];
    const released: { note: number }[] = [];
    const output: SynthOutput = {
      playNote: (note, _vel, when) => { played.push({ note, when: when ?? 0 }); },
      releaseNote: (note) => { released.push({ note }); },
    };
    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    return { clock, patterns, arrangement, seq, played, released };
  }

  it('plays every track on the same step, layering into a chord', () => {
    const { patterns, clock, played, seq } = build();
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 0.5 });
    patterns.setSeqStep(1, 0, { on: true, note: 64, velocity: 0.8, gate: 0.5 });
    patterns.setSeqStep(2, 0, { on: true, note: 67, velocity: 0.8, gate: 0.5 });
    seq.setEnabled(true);
    clock.fireTick(0);
    expect(played.map((p) => p.note).sort((a, b) => a - b)).toEqual([60, 64, 67]);
  });

  it('each track keeps its own held note — one track’s rest never cuts another', () => {
    const { patterns, clock, played, seq } = build();
    // Track 1 ties across step 1; track 2 rests there and must not interfere.
    patterns.setSeqStep(0, 0, { on: true, note: 60, gate: 0.5, tie: true });
    patterns.setSeqStep(0, 1, { on: true, note: 62, gate: 0.5 });
    patterns.setSeqStep(1, 0, { on: true, note: 72, gate: 0.5 });
    seq.setEnabled(true);
    clock.fireTick(0);
    clock.fireTick(1);
    expect(played.map((p) => p.note)).toContain(62);
  });

  it('mono voicing gates tracks 2-4 but keeps track 1 (REQ-9)', () => {
    const { patterns, clock, played, seq } = build();
    patterns.setSeqStep(0, 0, { on: true, note: 60, gate: 0.5 });
    patterns.setSeqStep(1, 0, { on: true, note: 64, gate: 0.5 });
    seq.setEnabled(true);
    seq.setPolyphonic(false);
    clock.fireTick(0);
    expect(played.map((p) => p.note)).toEqual([60]);

    // Flipping back to poly brings the track straight back — nothing was lost.
    // (fireTick's argument is the audio TIME; the step comes from clock.step.)
    played.length = 0;
    seq.setPolyphonic(true);
    clock.step = 0;
    clock.fireTick(0);
    expect(played.map((p) => p.note).sort((a, b) => a - b)).toEqual([60, 64]);
  });

  it('a per-track mute silences only that track (REQ-10)', () => {
    const { patterns, clock, played, seq } = build();
    patterns.setSeqStep(0, 0, { on: true, note: 60, gate: 0.5 });
    patterns.setSeqStep(1, 0, { on: true, note: 64, gate: 0.5 });
    seq.setEnabled(true);
    seq.setTrackMuted(1, true);
    clock.fireTick(0);
    expect(played.map((p) => p.note)).toEqual([60]);
  });

  it('a rest bar releases every track’s tied note', () => {
    const { patterns, clock, arrangement, released, seq } = build();
    patterns.setSeqStep(0, 15, { on: true, note: 60, gate: 0.5, tie: true });
    patterns.setSeqStep(1, 15, { on: true, note: 64, gate: 0.5, tie: true });
    seq.setEnabled(true);
    clock.step = 15;
    clock.fireTick(0);   // step 15: both tracks tie into the next bar
    released.length = 0;
    arrangement.setSeqChain([-1], true); // REST
    clock.fireTick(0);   // step 16 = bar boundary, now a rest bar
    expect(released.map((r) => r.note).sort((a, b) => a - b)).toEqual([60, 64]);
  });
});
