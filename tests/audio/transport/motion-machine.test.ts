import { describe, it, expect } from 'vitest';
import { MotionMachine } from '../../../src/audio/transport/motion-machine';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import { PatternStore, SEQ_LENGTH } from '../../../src/state/patterns';
import { ParamBus, registerDefaults } from '../../../src/state/params';
import { XyPadStore } from '../../../src/state/xy-pad';
import { fromNorm } from '../../../src/utils/taper';
import { TestClock } from './test-clock';

/**
 * MotionMachine against a real ParamBus + Arrangement and the synchronous
 * TestClock. The rAF loop is bypassed: tests drive `frame(now)` directly
 * (the loop's only job is calling it), with no-op raf/caf injected.
 */
function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  const clock = new TestClock();
  const arrangement = new Arrangement(patterns, clock);
  const xy = new XyPadStore(); // defaults: x=filter.cutoff, y=filter.resonance
  const machine = new MotionMachine(clock, patterns, arrangement, xy, bus, {
    raf: () => 0,
    caf: () => {},
  });
  return { bus, patterns, clock, arrangement, xy, machine };
}

/** Set an anchor on the edit bank. */
function anchor(patterns: PatternStore, step: number, x: number, y: number): void {
  patterns.setMotionStep(step, { on: true, x, y });
}

const STEP_DUR = 60 / 120 / 4; // TestClock default BPM

describe('MotionMachine', () => {
  it('does nothing while disabled or when the bank has no anchors', () => {
    const { bus, patterns, clock, machine } = build();
    const before = bus.get('filter.cutoff');
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);           // disabled
    machine.setEnabled(true);
    machine.frame(0);           // enabled but empty bank
    expect(bus.get('filter.cutoff')).toBe(before);
    anchor(patterns, 0, 0.5, 0.5);
    machine.frame(0);           // now it writes
    expect(bus.get('filter.cutoff')).not.toBe(before);
  });

  it('step mode writes the anchor value at the step and holds it', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    machine.setSlide(false);
    anchor(patterns, 0, 0, 0);      // norm 0 on both axes
    anchor(patterns, 8, 1, 1);      // norm 1
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    const defX = bus.def('filter.cutoff')!;
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0));
    // Mid-gap: still the step-0 value.
    machine.frame(4 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0));
    // Past the step-8 anchor (the tick advances the position reference).
    for (let i = 1; i <= 8; i++) clock.fireTick(i * STEP_DUR);
    machine.frame(8 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 1));
  });

  it('slide mode interpolates between anchors at sub-step times', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    anchor(patterns, 0, 0, 0);
    anchor(patterns, 8, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    // Halfway to step 8 (4 steps after tick 0) → norm 0.5 on both axes.
    machine.frame(4 * STEP_DUR);
    const defX = bus.def('filter.cutoff')!;
    const defY = bus.def('filter.resonance')!;
    expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(defX, 0.5), 6);
    expect(bus.get('filter.resonance')).toBeCloseTo(fromNorm(defY, 0.5), 6);
  });

  it('restores every touched param to its pre-play value on stop', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    const res0 = bus.get('filter.resonance');
    anchor(patterns, 0, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0);
    clock.fireStop();
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
    expect(bus.get('filter.resonance')).toBe(res0);
  });

  it('restores baselines when the machine is disabled mid-play', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    anchor(patterns, 0, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    machine.setEnabled(false);
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
  });

  // motion-sequencer.md REQ-21 — a seek clears the tick latch and NOTHING else.
  // Copying onStop's reset here (the obvious mistake, since the two hooks sit
  // side by side) would lose the user's original sound for the whole session.
  it('keeps the baselines across a seek, so stop still restores the ORIGINAL value', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    anchor(patterns, 0, 1, 1);
    anchor(patterns, 8, 0, 0);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0); // automation took over

    clock.fireSeek(8);
    clock.fireTick(STEP_DUR * 8);
    machine.frame(STEP_DUR * 8);

    clock.fireStop();
    // Not "whatever automation had written when we seeked" — the pre-play value.
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
  });

  it('drops the tick latch on a seek so no value glides across the jump', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    anchor(patterns, 0, 0, 0);
    anchor(patterns, 8, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);

    // Jump to the far anchor. With a stale prev/curr pair the loop would
    // interpolate from step 0's anchor toward it; with the latch cleared the
    // first frame after the jump lands ON the new position's curve value.
    clock.fireSeek(8);
    clock.fireTick(STEP_DUR * 8);
    machine.frame(STEP_DUR * 8);

    const defX = bus.def('filter.cutoff')!;
    expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(defX, 1), 6);
  });

  it('resolves per-bank assignment overrides with per-axis fallback', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    // Bank A overrides only x → fx.delay.mix; y falls back to the pad's param.
    patterns.setMotionAssign({ x: 'fx.delay.mix' });
    anchor(patterns, 0, 1, 1);
    const delay0 = bus.get('fx.delay.mix');
    const cutoff0 = bus.get('filter.cutoff');
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('fx.delay.mix')).not.toBe(delay0);
    expect(bus.get('filter.cutoff')).toBe(cutoff0);              // x went elsewhere
    expect(bus.get('filter.resonance')).toBe(bus.def('filter.resonance')!.max); // y fallback
    // Stop restores params from BOTH assignments' history.
    clock.fireStop();
    expect(bus.get('fx.delay.mix')).toBe(delay0);
  });

  it('writes nothing while the arrangement lane rests', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    machine.setEnabled(true);
    anchor(patterns, 0, 1, 1);
    arrangement.setMotionChain([-1], true); // REST bar
    const cutoff0 = bus.get('filter.cutoff');
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
  });

  it('rest gate waits for the audible bar boundary (regression: look-ahead froze the wrong value)', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    machine.setEnabled(true);
    machine.setSlide(false);
    anchor(patterns, 12, 1, 1);   // high plateau
    anchor(patterns, 15, 0, 0);   // the "come back down" anchor
    arrangement.setMotionChain([0, -1], true); // bank A, then a REST bar
    const defX = bus.def('filter.cutoff')!;
    clock.fireStart();
    for (let i = 0; i <= 15; i++) clock.fireTick(i * STEP_DUR);
    machine.frame(14.5 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 1)); // anchor-12 hold
    // The rest bar's first tick arrives scheduled ahead of its audible time;
    // the arrangement flips motionResting NOW, but step 15 hasn't sounded yet.
    clock.fireTick(16 * STEP_DUR);
    machine.frame(15.5 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0)); // anchor 15 still writes
    // From the audible boundary on, the rest holds (no further writes).
    machine.frame(16.5 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0));
  });

  it('bank switches apply at the audible bar boundary, not at schedule time', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    machine.setEnabled(true);
    machine.setSlide(false);
    anchor(patterns, 0, 1, 1);                 // bank A: high
    patterns.setMotionEditBank(1);
    anchor(patterns, 0, 0, 0);                 // bank B: low
    patterns.setMotionEditBank(0);
    arrangement.setMotionChain([0, 1], true);
    const defX = bus.def('filter.cutoff')!;
    clock.fireStart();
    for (let i = 0; i <= 15; i++) clock.fireTick(i * STEP_DUR);
    // Bank B's first tick arrives ahead of time; frames before its `when`
    // must still evaluate bank A.
    clock.fireTick(16 * STEP_DUR);
    machine.frame(15.9 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 1));
    machine.frame(16 * STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(fromNorm(defX, 0));
  });

  describe('bar-line carry across banks (REQ-2b)', () => {
    /** Fill bank `i` with anchors (+ an optional assign), restoring the edit bank. */
    function fill(
      patterns: PatternStore,
      i: number,
      anchors: Record<number, number>,
      assign?: { x: string; y: string },
    ): void {
      const edit = patterns.motionEditBank;
      patterns.setMotionEditBank(i);
      for (const [s, y] of Object.entries(anchors)) anchor(patterns, Number(s), y, y);
      if (assign) patterns.setMotionAssign(assign);
      patterns.setMotionEditBank(edit);
    }

    /**
     * Drive the clock forward to absolute step position `pos` (fractional) and
     * evaluate one frame there. Ticks are fired once each, as the transport does.
     */
    function driver(clock: TestClock, machine: MotionMachine) {
      let next = 0;
      return (pos: number): void => {
        for (; next <= Math.floor(pos); next++) clock.fireTick(next * STEP_DUR);
        machine.frame(pos * STEP_DUR);
      };
    }
    const bar = (n: number, step: number): number => n * SEQ_LENGTH + step;

    // The reported bug: a delay throw built at the end of one bank, handed to the
    // next. Pre-v3 the final 16th raced back to the *same* bank's first anchor.
    const D = { 0: 0.13, 10: 0.13, 14: 0.58, 15: 0.53 };
    const A = { 0: 0.55, 7: 0.52, 13: 0.16, 15: 0.13 };

    it('holds the throw into the next bank instead of collapsing to its own opening', () => {
      const { bus, patterns, clock, arrangement, machine } = build();
      machine.setEnabled(true);
      fill(patterns, 0, D);
      fill(patterns, 1, A);
      arrangement.setMotionChain([0, 1], true);
      const def = bus.def('filter.cutoff')!;
      clock.fireStart();
      const frameAt = driver(clock, machine);
      // Deep into bank D's final step: climbing toward A's opening, not diving.
      frameAt(bar(0, 15.5));
      expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(def, 0.54), 6);
      // …and bank A opens exactly where D left off.
      frameAt(bar(1, 0));
      expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(def, 0.55), 6);
    });

    it('holds the last anchor toward an anchorless bank, which then keeps it there', () => {
      const { bus, patterns, clock, arrangement, machine } = build();
      machine.setEnabled(true);
      fill(patterns, 0, A);              // bank B (index 1) stays empty
      arrangement.setMotionChain([0, 1], true);
      const def = bus.def('filter.cutoff')!;
      clock.fireStart();
      const frameAt = driver(clock, machine);
      frameAt(bar(0, 15.5));
      expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(def, 0.13), 6);
      // The empty bank writes nothing (REQ-3) — so the value it inherits is A's
      // last anchor, not the 0.55 the old self-wrap sprang back up to.
      frameAt(bar(1, 8));
      expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(def, 0.13), 6);
    });

    it('does not carry into a bank that drives different params', () => {
      const { bus, patterns, clock, arrangement, machine } = build();
      machine.setEnabled(true);
      fill(patterns, 0, A);
      fill(patterns, 1, D, { x: 'fx.delay.mix', y: 'fx.delay.mix' });
      arrangement.setMotionChain([0, 1], true);
      const def = bus.def('filter.cutoff')!;
      clock.fireStart();
      // D's anchors are in fx.delay.mix's space — meaningless to ramp toward, so
      // bank A simply holds its own last anchor to the bar line.
      driver(clock, machine)(bar(0, 15.5));
      expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(def, 0.13), 6);
    });

    it('a chain that repeats one bank still wraps within it (back-compat)', () => {
      const { bus, patterns, clock, arrangement, machine } = build();
      machine.setEnabled(true);
      anchor(patterns, 4, 0, 0);
      anchor(patterns, 12, 1, 1);
      arrangement.setMotionChain([0, 0], true);
      const def = bus.def('filter.cutoff')!;
      clock.fireStart();
      // The 12→4 wrap spans 8 steps across the bar line; step 0 is halfway.
      driver(clock, machine)(bar(1, 0));
      expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(def, 0.5), 6);
    });
  });

  it('reads the play bank the arrangement selects, not the edit bank', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    machine.setEnabled(true);
    // Bank B carries the anchors; the chain plays B while A stays the edit bank.
    patterns.setMotionEditBank(1);
    anchor(patterns, 0, 1, 1);
    patterns.setMotionEditBank(0);
    arrangement.setMotionChain([1], true);
    const cutoff0 = bus.get('filter.cutoff');
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0);
  });

  it('muting mid-play stops writes and restores baselines; unmuting resumes (REQ-12)', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    anchor(patterns, 0, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0);
    machine.setMuted(true);
    expect(bus.get('filter.cutoff')).toBe(cutoff0); // baseline restored
    machine.frame(STEP_DUR);                        // frames are inert while muted
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
    machine.setMuted(false);
    machine.frame(2 * STEP_DUR);                    // automation resumes
    expect(bus.get('filter.cutoff')).not.toBe(cutoff0);
  });

  it('mute + disable never double-restores or loses the baseline', () => {
    const { bus, patterns, clock, machine } = build();
    machine.setEnabled(true);
    const cutoff0 = bus.get('filter.cutoff');
    anchor(patterns, 0, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    machine.setMuted(true);      // restores
    machine.setEnabled(false);   // already inactive — a no-op flip
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
    // Re-enabling while still muted must NOT start writing.
    machine.setEnabled(true);
    machine.frame(STEP_DUR);
    expect(bus.get('filter.cutoff')).toBe(cutoff0);
  });

  // runtime-performance.md REQ-6 — the frame loop memoizes each bank's anchor
  // set, and banks are mutated in place, so every edit stream must drop the memo.
  // A stale entry would make automation quietly ignore the user's edit.
  describe('anchor memo invalidation', () => {
    const cutoffAt = (bus: ParamBus, n: number): number =>
      fromNorm(bus.def('filter.cutoff')!, n);

    it('picks up a step added after the bank was first evaluated', () => {
      const { bus, patterns, clock, machine } = build();
      machine.setEnabled(true);
      machine.setSlide(false); // step mode: the value IS the anchor
      anchor(patterns, 0, 0.2, 0.5);
      clock.fireStart();
      clock.fireTick(0);
      machine.frame(0);
      expect(bus.get('filter.cutoff')).toBeCloseTo(cutoffAt(bus, 0.2), 6);

      // A new anchor at step 4 — same array, mutated in place.
      anchor(patterns, 4, 0.9, 0.5);
      clock.fireTick(4);
      machine.frame(STEP_DUR * 4);
      expect(bus.get('filter.cutoff')).toBeCloseTo(cutoffAt(bus, 0.9), 6);
    });

    it('picks up a step removed after the bank was first evaluated', () => {
      const { bus, patterns, clock, machine } = build();
      machine.setEnabled(true);
      machine.setSlide(false);
      anchor(patterns, 0, 0.2, 0.5);
      anchor(patterns, 4, 0.9, 0.5);
      clock.fireStart();
      clock.fireTick(4);
      machine.frame(STEP_DUR * 4);
      expect(bus.get('filter.cutoff')).toBeCloseTo(cutoffAt(bus, 0.9), 6);

      patterns.setMotionStep(4, { on: false });
      clock.fireTick(4);
      machine.frame(STEP_DUR * 4);
      // Step 4 is gone, so step 0's anchor holds through it again.
      expect(bus.get('filter.cutoff')).toBeCloseTo(cutoffAt(bus, 0.2), 6);
    });

    it('picks up a whole-store restore (song load)', () => {
      const { bus, patterns, clock, machine } = build();
      machine.setEnabled(true);
      machine.setSlide(false);
      anchor(patterns, 0, 0.2, 0.5);
      clock.fireStart();
      clock.fireTick(0);
      machine.frame(0);

      const snap = patterns.snapshot();
      snap.motionBanks![0]![0] = { on: true, x: 0.7, y: 0.5 };
      patterns.restore(snap);
      clock.fireTick(0);
      machine.frame(0);
      expect(bus.get('filter.cutoff')).toBeCloseTo(cutoffAt(bus, 0.7), 6);
    });
  });

  // REQ-15 / runtime-performance.md REQ-5. The per-param listeners must still
  // fire (knobs and the XY pad track the automation); only the global "the user
  // edited the sound" signal is withheld — it drives the session autosave
  // debounce and the preset dirty marker, and at frame rate it starved both.
  it('automation writes reach per-param listeners but not onChange (REQ-15)', () => {
    const { bus, patterns, clock, machine } = build();
    const perParam: number[] = [];
    const global: string[] = [];
    bus.subscribe('filter.cutoff', (v) => perParam.push(v));
    bus.onChange((id) => global.push(id));

    machine.setEnabled(true);
    anchor(patterns, 0, 0, 0);
    anchor(patterns, 8, 1, 1);
    clock.fireStart();
    clock.fireTick(0);
    for (let i = 1; i <= 8; i++) machine.frame(STEP_DUR * (i / 8));

    // subscribe() fires once immediately, then once per distinct written value.
    expect(perParam.length).toBeGreaterThan(1);
    expect(global).toEqual([]);

    // The baseline restore is the same kind of write, so it is silent too.
    clock.fireStop();
    expect(bus.get('filter.cutoff')).toBe(perParam[0]);
    expect(global).toEqual([]);

    // A genuine user edit still signals normally.
    bus.set('filter.cutoff', 55);
    expect(global).toEqual(['filter.cutoff']);
  });

  it('notifies step listeners with the raw step only while enabled', () => {
    const { clock, machine } = build();
    const seen: number[] = [];
    machine.onStep((s) => seen.push(s));
    clock.fireStart();
    clock.fireTick(0);
    expect(seen).toEqual([]);
    machine.setEnabled(true);
    clock.fireTick(0.125);
    clock.fireTick(0.25);
    expect(seen).toEqual([1 % SEQ_LENGTH, 2 % SEQ_LENGTH]);
  });
});

describe('MotionMachine — extra single-param tracks (motion-sequencer.md REQ-13/REQ-15)', () => {
  /** Assign a track and anchor two of its steps on the edit bank. */
  const setupTrack = (patterns: PatternStore, track: number, param: string,
    anchors: Record<number, number>): void => {
    patterns.setMotionTrackParam(track, param);
    for (const [step, v] of Object.entries(anchors)) {
      patterns.setMotionTrackStep(track, Number(step), { on: true, v });
    }
  };

  it('drives its chosen param, independently of the XY axes', () => {
    const { bus, patterns, clock, machine } = build();
    setupTrack(patterns, 0, 'fx.delay.mix', { 0: 0, 8: 1 });
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('fx.delay.mix')).toBeCloseTo(fromNorm(bus.def('fx.delay.mix')!, 0), 6);

    clock.fireTick(8);
    machine.frame(8 * STEP_DUR);
    expect(bus.get('fx.delay.mix')).toBeCloseTo(fromNorm(bus.def('fx.delay.mix')!, 1), 6);
  });

  it('an unassigned track writes nothing (the no-op default)', () => {
    const { bus, patterns, clock, machine } = build();
    // Anchors but no param chosen: there is nothing to drive.
    patterns.setMotionTrackStep(0, 0, { on: true, v: 1 });
    const before = bus.get('fx.delay.mix');
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('fx.delay.mix')).toBe(before);
  });

  it('an assigned track with no anchors writes nothing', () => {
    const { bus, patterns, clock, machine } = build();
    patterns.setMotionTrackParam(0, 'fx.delay.mix');
    const before = bus.get('fx.delay.mix');
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('fx.delay.mix')).toBe(before);
  });

  it('both tracks run at once, so one bank can drive four params', () => {
    const { bus, patterns, clock, machine } = build();
    anchor(patterns, 0, 0.25, 0.75);
    setupTrack(patterns, 0, 'fx.delay.mix', { 0: 1 });
    setupTrack(patterns, 1, 'fx.reverb.mix', { 0: 1 });
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('fx.delay.mix')).toBeCloseTo(fromNorm(bus.def('fx.delay.mix')!, 1), 6);
    expect(bus.get('fx.reverb.mix')).toBeCloseTo(fromNorm(bus.def('fx.reverb.mix')!, 1), 6);
    expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(bus.def('filter.cutoff')!, 0.25), 6);
  });

  it('restores a track param’s baseline on stop, like the axes (REQ-15)', () => {
    const { bus, patterns, clock, machine } = build();
    const before = bus.get('fx.delay.mix');
    setupTrack(patterns, 0, 'fx.delay.mix', { 0: 1 });
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('fx.delay.mix')).not.toBe(before);

    clock.fireStop();
    expect(bus.get('fx.delay.mix')).toBe(before);
  });

  it('mute restores track baselines too', () => {
    const { bus, patterns, clock, machine } = build();
    const before = bus.get('fx.delay.mix');
    setupTrack(patterns, 0, 'fx.delay.mix', { 0: 1 });
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    machine.setMuted(true);
    expect(bus.get('fx.delay.mix')).toBe(before);
  });

  it('a rest bar writes nothing on the tracks either', () => {
    const { bus, patterns, clock, arrangement, machine } = build();
    setupTrack(patterns, 0, 'fx.delay.mix', { 0: 1 });
    const before = bus.get('fx.delay.mix');
    arrangement.setMotionChain([-1], true); // REST
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(0);
    expect(bus.get('fx.delay.mix')).toBe(before);
  });
});

describe('MotionMachine — per-lane Slide/Step (motion-sequencer.md REQ-2)', () => {
  const setupTrack = (patterns: PatternStore, track: number, param: string,
    anchors: Record<number, number>): void => {
    patterns.setMotionTrackParam(track, param);
    for (const [step, v] of Object.entries(anchors)) {
      patterns.setMotionTrackStep(track, Number(step), { on: true, v: v });
    }
  };

  it('two tracks interpolate differently in the same bar', () => {
    const { bus, patterns, clock, machine } = build();
    // Identical anchors on both tracks; only the MODE differs.
    setupTrack(patterns, 0, 'fx.delay.mix', { 0: 0, 8: 1 });
    setupTrack(patterns, 1, 'fx.reverb.mix', { 0: 0, 8: 1 });
    machine.setTrackSlide(0, false); // A = step
    machine.setTrackSlide(1, true);  // B = slide
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);

    // Halfway to the step-8 anchor: A still holds step 0's value, B is midway.
    machine.frame(4 * STEP_DUR);
    expect(bus.get('fx.delay.mix')).toBeCloseTo(fromNorm(bus.def('fx.delay.mix')!, 0), 6);
    expect(bus.get('fx.reverb.mix')).toBeCloseTo(fromNorm(bus.def('fx.reverb.mix')!, 0.5), 6);
  });

  it('the XY lane keeps its own mode, independent of the tracks', () => {
    const { bus, patterns, clock, machine } = build();
    anchor(patterns, 0, 0, 0);
    anchor(patterns, 8, 1, 1);
    setupTrack(patterns, 0, 'fx.delay.mix', { 0: 0, 8: 1 });
    machine.setSlide(true);          // XY = slide
    machine.setTrackSlide(0, false); // track A = step
    machine.setEnabled(true);
    clock.fireStart();
    clock.fireTick(0);
    machine.frame(4 * STEP_DUR);

    // XY ramps to the midpoint while the track holds its first anchor.
    expect(bus.get('filter.cutoff')).toBeCloseTo(fromNorm(bus.def('filter.cutoff')!, 0.5), 6);
    expect(bus.get('fx.delay.mix')).toBeCloseTo(fromNorm(bus.def('fx.delay.mix')!, 0), 6);
  });

  it('setTrackSlide ignores an out-of-range track (edge)', () => {
    const { machine } = build();
    expect(() => { machine.setTrackSlide(9, false); }).not.toThrow();
  });
});

/**
 * The frame loop's *driver* (REQ-20) — the half `build()` deliberately bypasses.
 * Browsers suspend rAF for a hidden document, so a bare rAF loop froze motion
 * whenever the tab was backgrounded while every other machine (worker-driven
 * clock) kept playing. Here the drivers are all injected, so the swap is
 * observable without a real frame loop or a real `document`.
 */
describe('MotionMachine frame driver', () => {
  function buildDriven(fps = 30) {
    const bus = new ParamBus();
    registerDefaults(bus);
    const patterns = new PatternStore();
    const clock = new TestClock();
    const arrangement = new Arrangement(patterns, clock);
    const xy = new XyPadStore();

    // A fake document whose visibility the test flips by hand.
    let onVisibility: (() => void) | null = null;
    const doc = {
      hidden: false,
      addEventListener: (_t: 'visibilitychange', fn: () => void) => { onVisibility = fn; },
    };
    const setHidden = (h: boolean): void => { doc.hidden = h; onVisibility?.(); };

    // A fake TickTimer recording what the hidden driver asks of it.
    const timer = {
      starts: [] as number[],
      stops: 0,
      cb: null as (() => void) | null,
      start(cb: () => void, intervalMs: number) { this.cb = cb; this.starts.push(intervalMs); },
      stop() { this.cb = null; this.stops++; },
    };

    const rafCbs: Array<() => void> = [];
    const cancelled: number[] = [];
    let nextRafId = 0;

    // The audio clock, advanced by the test.
    let now = 0;
    const machine = new MotionMachine(clock, patterns, arrangement, xy, bus, {
      fps,
      now: () => now,
      raf: (cb) => { rafCbs.push(cb); return ++nextRafId; },
      caf: (id) => { cancelled.push(id); },
      timer,
      doc,
    });
    return {
      bus, patterns, clock, machine, timer, rafCbs, cancelled,
      setHidden,
      advance: (t: number) => { now = t; },
    };
  }

  /** Enabled, anchored and playing — the state in which the loop is armed. */
  function play(h: ReturnType<typeof buildDriven>): void {
    anchor(h.patterns, 0, 0, 0);
    anchor(h.patterns, 8, 1, 1);
    h.machine.setEnabled(true);
    h.clock.fireStart();
    h.clock.fireTick(0);
  }

  it('drives on rAF while the document is visible', () => {
    const h = buildDriven();
    play(h);
    expect(h.rafCbs.length).toBe(1);
    expect(h.timer.starts).toEqual([]);
  });

  it('swaps to the worker-backed timer at the perf fps when hidden (REQ-20, regression)', () => {
    const h = buildDriven(30);
    play(h);
    h.setHidden(true);

    expect(h.cancelled).toEqual([1]);          // the rAF driver was released
    expect(h.timer.starts).toEqual([1000 / 30]);
    expect(h.rafCbs.length).toBe(1);           // and not re-armed
  });

  it('keeps writing the assigned params while hidden', () => {
    const h = buildDriven();
    play(h);
    h.setHidden(true);
    const before = h.bus.get('filter.cutoff');

    // Two wakeups a quarter-bar apart: the slide must have moved between them.
    h.advance(2 * STEP_DUR);
    h.timer.cb?.();
    const mid = h.bus.get('filter.cutoff');
    h.advance(4 * STEP_DUR);
    h.timer.cb?.();
    const later = h.bus.get('filter.cutoff');

    expect(mid).not.toBe(before);
    expect(later).not.toBe(mid);
    expect(later).toBeCloseTo(fromNorm(h.bus.def('filter.cutoff')!, 0.5), 6);
  });

  it('does not restore baselines when the document is merely hidden (REQ-5)', () => {
    const h = buildDriven();
    const base = h.bus.get('filter.cutoff');
    play(h);
    h.advance(4 * STEP_DUR);
    h.machine.frame(4 * STEP_DUR);
    const automated = h.bus.get('filter.cutoff');
    expect(automated).not.toBe(base);

    h.setHidden(true);
    expect(h.bus.get('filter.cutoff')).toBe(automated);
  });

  it('returns to rAF when the document is shown again', () => {
    const h = buildDriven();
    play(h);
    h.setHidden(true);
    h.setHidden(false);

    expect(h.timer.stops).toBeGreaterThan(0);
    expect(h.timer.cb).toBe(null);
    expect(h.rafCbs.length).toBe(2);
  });

  it('stopping while hidden stops the timer and restores the baselines', () => {
    const h = buildDriven();
    const base = h.bus.get('filter.cutoff');
    play(h);
    h.setHidden(true);
    h.advance(4 * STEP_DUR);
    h.timer.cb?.();
    expect(h.bus.get('filter.cutoff')).not.toBe(base);

    h.clock.fireStop();
    expect(h.timer.cb).toBe(null);
    expect(h.bus.get('filter.cutoff')).toBe(base);
  });

  it('a wakeup arriving after stop writes nothing', () => {
    const h = buildDriven();
    const base = h.bus.get('filter.cutoff');
    play(h);
    h.setHidden(true);
    const wake = h.timer.cb;          // captured while running, as a real one would be
    h.clock.fireStop();
    h.advance(4 * STEP_DUR);
    wake?.();

    expect(h.bus.get('filter.cutoff')).toBe(base);
  });

  it('arms the hidden driver directly when play starts on a hidden document', () => {
    const h = buildDriven(60);
    h.setHidden(true);                // nothing armed yet — setHidden is a no-op here
    expect(h.timer.starts).toEqual([]);
    play(h);

    expect(h.timer.starts).toEqual([1000 / 60]);
    expect(h.rafCbs.length).toBe(0);
  });
});
