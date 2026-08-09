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

  // sequencer.md REQ-14 — tie/held-note state only ever describes the ADJACENT
  // step, so a playhead jump must not carry it across.
  it('releases the held note on a transport seek (v4)', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote: vi.fn(), releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 1, tie: true });

    clock.fireTick(0);
    releaseNote.mockClear();
    clock.fireSeek(64);
    expect(releaseNote).toHaveBeenCalledWith(60, undefined);
  });

  // sequencer.md REQ-15 — a tie schedules NO release of its own (that is the next
  // tick's job), so before this the note rang on forever after Stop and only Panic
  // silenced it.
  it('releases a tied note on a transport stop (v5, regression)', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote: vi.fn(), releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 1, tie: true });

    clock.fireTick(0);
    releaseNote.mockClear();
    clock.fireStop();
    // Released at the step's own gate end (one 16th at 120 BPM), NOT at `now`:
    // the note-on may still sit in the look-ahead, and a release scheduled before
    // its attack would be overwritten by it — the very hang this fixes.
    expect(releaseNote).toHaveBeenCalledWith(60, 0.125);
  });

  it('stop-releases each track at its own gate end, never before its note-on (v5, edge)', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    // Two tracks, different gates, both tied — each must be released on its own
    // schedule rather than all of them sharing one moment.
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 1, tie: true });
    patterns.setSeqStep(1, 0, { on: true, note: 67, velocity: 0.8, gate: 0.5, tie: true });

    // Ticked at a future audio time, as the look-ahead really does.
    clock.fireTick(2);
    releaseNote.mockClear();
    clock.fireStop();

    expect(releaseNote).toHaveBeenCalledWith(60, 2.125);
    expect(releaseNote).toHaveBeenCalledWith(67, 2.0625);
    for (const [, when] of releaseNote.mock.calls) expect(when).toBeGreaterThanOrEqual(2);
  });

  it('clears tie state on stop, so the next Play does not slur (v5, edge)', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 1, tie: true });
    patterns.setSeqStep(0, 1, { on: true, note: 67, velocity: 0.8, gate: 1 });

    clock.fireTick(0);   // 60 sounds, prevTied latched
    clock.fireStop();    // stale prevTied used to survive this (and a panic)
    releaseNote.mockClear();
    clock.fireStart(1);
    clock.fireTick(0.125);

    expect(playNote).toHaveBeenCalledWith(67, 0.8, 0.125);
    // prevTied was cleared by the stop, so nothing is left to slur out of.
    expect(releaseNote).not.toHaveBeenCalledWith(60, 0.125);
  });

  it('does not slur a tied note across a seek (v4, edge)', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const playNote = vi.fn();
    const releaseNote = vi.fn();
    const output: SynthOutput = { playNote, releaseNote };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    // Step 0 ties into step 1, which holds a different note.
    patterns.setSeqStep(0, 0, { on: true, note: 60, velocity: 0.8, gate: 1, tie: true });
    patterns.setSeqStep(0, 1, { on: true, note: 67, velocity: 0.8, gate: 1 });

    clock.fireTick(0);       // 60 sounds, prevTied latched
    clock.fireSeek(1);       // jump — the tie must not survive it
    playNote.mockClear();
    clock.fireTick(0.125);   // now step 1
    // prevTied cleared, so step 1 is played fresh rather than treated as a
    // continuation of the note that was tied into it.
    expect(playNote).toHaveBeenCalledWith(67, 0.8, 0.125);
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

  // v5: releaseAt is the LAST sub-hit's gate end. It used to be the first, so a
  // ratcheted step's on-screen key went dark while the step was still sounding.
  it('reports a ratcheted step releaseAt at its last sub-hit (v5)', () => {
    const { clock, patterns, arrangement, perf } = makeTransportRig();
    const output: SynthOutput = { playNote: vi.fn(), releaseNote: vi.fn() };

    const seq = new StepSequencer(output, clock, patterns, arrangement, perf);
    seq.setEnabled(true);
    patterns.setSeqStep(0, 0, { on: true, note: 72, velocity: 0.9, gate: 1, ratchet: 4 });

    const notes: Array<[number, number, number]> = [];
    seq.onNote((n, w, r) => notes.push([n, w, r]));

    clock.fireTick(0);
    // 4 sub-hits across one 16th: the last starts at 0.09375 and ends at 0.125,
    // not the first sub-hit's 0.03125.
    expect(notes[0]![2]).toBeCloseTo(0.125, 5);
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

  // sequencer.md REQ-16 / arrangement.md REQ-8. What this buys: four banks of
  // sixteen steps used to be a song's entire melodic vocabulary, so a four-chord
  // progression spent every bank.
  describe('arrangement transpose (REQ-16)', () => {
    it('shifts the notes a chained slot triggers', () => {
      const { patterns, clock, arrangement, played, seq } = build();
      patterns.setSeqStep(0, 0, { on: true, note: 60, gate: 0.5 });
      seq.setEnabled(true);
      arrangement.setSeqChain([0, 0], true, [0, 5]);

      clock.fireTick(0);              // bar 1, slot 0 → +0
      clock.step = 16;
      clock.fireTick(0.1);            // bar 2, slot 1 → +5
      expect(played.map((p) => p.note)).toEqual([60, 65]);
    });

    it('never rewrites the stored bank (REQ-9)', () => {
      const { patterns, clock, arrangement, seq } = build();
      patterns.setSeqStep(0, 0, { on: true, note: 60, gate: 0.5 });
      seq.setEnabled(true);
      arrangement.setSeqChain([0], true, [7]);
      clock.fireTick(0);
      expect(patterns.seqBanks[0]![0]![0]!.note).toBe(60);
    });

    it('does not transpose while the lane is disabled', () => {
      const { patterns, clock, arrangement, played, seq } = build();
      patterns.setSeqStep(0, 0, { on: true, note: 60, gate: 0.5 });
      seq.setEnabled(true);
      arrangement.setSeqChain([0], false, [7]); // chain off = live editing
      clock.fireTick(0);
      expect(played.map((p) => p.note)).toEqual([60]);
    });

    it('clamps a transposed note into the MIDI range instead of dropping it', () => {
      const { patterns, clock, arrangement, played, seq } = build();
      patterns.setSeqStep(0, 0, { on: true, note: 120, gate: 0.5 });
      seq.setEnabled(true);
      arrangement.setSeqChain([0], true, [24]);
      clock.fireTick(0);
      // 144 would be Infinity Hz at the oscillator; a dropped note would make a
      // transposed bar silently lose part of its line.
      expect(played.map((p) => p.note)).toEqual([127]);
    });

    it('releases a note tied across a bar line at ITS OWN pitch (edge)', () => {
      const { patterns, clock, arrangement, played, released, seq } = build();
      // Step 15 ties into the next bar, which is transposed differently. Step 0
      // is untied, so bar 2's step 0 releases at its own gate end — that release
      // is the one that must carry the *new* slot's pitch, while the tied voice
      // from bar 1 must not be re-pitched under it.
      patterns.setSeqStep(0, 15, { on: true, note: 60, gate: 0.5, tie: true });
      patterns.setSeqStep(0, 0, { on: true, note: 62, gate: 0.5 });
      seq.setEnabled(true);
      arrangement.setSeqChain([0, 0], true, [0, 7]);

      // The FIRST bar-line tick only consumes `expectFirstBar` (arrangement.md
      // REQ-4) — it does not advance — so bar 1 has to actually be played for
      // the tick at step 16 to move the lane to slot 1.
      clock.step = 0;
      clock.fireTick(0);              // bar 1, slot 0 (+0): step 0 plays 62
      clock.step = 15;
      clock.fireTick(0.1);            // still bar 1: plays 60 and ties
      expect(played.map((p) => p.note)).toEqual([62, 60]);
      played.length = 0;
      released.length = 0;

      clock.step = 16;
      clock.fireTick(0.2);            // bar 2, slot 1 (+7): step 0 plays 62+7
      expect(played.map((p) => p.note)).toEqual([69]);
      // A tie deliberately schedules no release of the held note — that is what
      // makes it slur. What must NOT happen is the new bar's release carrying a
      // pitch the old bar never started; the 69 released here is its own note.
      expect(released.map((r) => r.note)).toEqual([69]);
    });

    it('releases a tie into a REST at the pitch it started, not the new slot’s (edge)', () => {
      const { patterns, clock, arrangement, played, released, seq } = build();
      patterns.setSeqStep(0, 15, { on: true, note: 60, gate: 0.5, tie: true });
      seq.setEnabled(true);
      // Bar 2 is a rest, so the tied voice is released rather than slurred —
      // and `lastPlayedNote` is the only thing that knows its pitch.
      arrangement.setSeqChain([0, -1], true, [0, 7]);

      clock.step = 0;
      clock.fireTick(0);
      clock.step = 15;
      clock.fireTick(0.1);            // plays 60 (+0) and ties
      played.length = 0;
      released.length = 0;

      clock.step = 16;
      clock.fireTick(0.2);            // rest bar: release the tied voice
      expect(played).toEqual([]);
      expect(released.map((r) => r.note)).toEqual([60]); // NOT 67
    });
  });
});
