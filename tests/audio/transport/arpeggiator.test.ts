import { describe, it, expect, vi, afterEach } from 'vitest';
import { Arpeggiator } from '../../../src/audio/transport/arpeggiator';
import { ParamBus } from '../../../src/state/params';
import { TestClock } from './test-clock';
import type { SynthOutput } from '../../../src/audio/transport/note-output';

function setup() {
  const clock = new TestClock();
  const bus = new ParamBus();
  const playNote = vi.fn();
  const releaseNote = vi.fn();
  const output: SynthOutput = { playNote, releaseNote };
  const arp = new Arpeggiator(output, bus, clock);
  return { clock, bus, arp, playNote, releaseNote };
}

/** The note arg of each playNote call, in order. */
function played(playNote: ReturnType<typeof vi.fn>): number[] {
  return playNote.mock.calls.map((c) => c[0] as number);
}

describe('Arpeggiator auto-start', () => {
  it('starts the transport when a key is held while engaged', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);

    bus.noteOn(60);
    expect(clock.playing).toBe(true);

    clock.fireTick(0); // step 0 → the held note arpeggiates
    expect(playNote).toHaveBeenCalledWith(60, 0.85, 0);
  });

  it('stops the transport when the last key is released', () => {
    const { clock, bus, arp } = setup();
    arp.setEnabled(true);

    bus.noteOn(60);
    expect(clock.playing).toBe(true);
    bus.noteOff(60);
    expect(clock.playing).toBe(false);
  });

  it('never stops a transport the user started with Play', () => {
    const { clock, bus, arp } = setup();
    arp.setEnabled(true);
    clock.fireStart(); // simulate the user pressing Play

    bus.noteOn(60);
    bus.noteOff(60);
    expect(clock.playing).toBe(true); // still running — arp didn't own it
  });

  it('does not start the transport when the arp is disabled', () => {
    const { clock, bus } = setup();
    // arp left disabled
    bus.noteOn(60);
    expect(clock.playing).toBe(false);
  });

  it('disabling the arp relinquishes a transport it auto-started', () => {
    const { clock, bus, arp } = setup();
    arp.setEnabled(true);
    bus.noteOn(60);
    expect(clock.playing).toBe(true);

    arp.setEnabled(false);
    expect(clock.playing).toBe(false);
  });
});

describe('Arpeggiator pattern generation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('walks the pool upward on the "up" pattern', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(0); // up
    bus.noteOn(60);
    bus.noteOn(64);
    bus.noteOn(67);

    clock.fireTicks(4);
    // sorted pool [60,64,67] cycles
    expect(played(playNote)).toEqual([60, 64, 67, 60]);
  });

  it('walks the pool downward on the "down" pattern', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(1); // down
    bus.noteOn(60);
    bus.noteOn(64);
    bus.noteOn(67);

    clock.fireTicks(4);
    expect(played(playNote)).toEqual([67, 64, 60, 67]);
  });

  it('bounces without repeating the endpoints on "up-down"', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(2); // up-down
    bus.noteOn(60);
    bus.noteOn(64);
    bus.noteOn(67);

    clock.fireTicks(6);
    expect(played(playNote)).toEqual([60, 64, 67, 64, 60, 64]);
  });

  it('holds a single note on "up-down" with one key', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(2); // up-down
    bus.noteOn(60);

    clock.fireTicks(3);
    expect(played(playNote)).toEqual([60, 60, 60]);
  });

  it('follows press order on "as-played"', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(4); // as-played
    bus.noteOn(64); // pressed first
    bus.noteOn(60); // pressed second

    clock.fireTicks(3);
    expect(played(playNote)).toEqual([64, 60, 64]);
  });

  it('"random" stays inside the held pool', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(3); // random
    bus.noteOn(60);
    bus.noteOn(64);

    clock.fireTicks(3);
    // 0.99 * pool.length floors to the top index of [60,64]
    expect(played(playNote)).toEqual([64, 64, 64]);
  });

  it('stacks octaves into the pool', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(0); // up
    arp.setOctaves(2);
    bus.noteOn(60);

    clock.fireTicks(4);
    // pool becomes [60, 72]
    expect(played(playNote)).toEqual([60, 72, 60, 72]);
  });

  it('only triggers on the chosen subdivision boundary', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(0);
    arp.setRate(0); // 1/4 → division 4: fire only when step % 4 === 0
    bus.noteOn(60);

    clock.fireTicks(8); // steps 0..7 → fires at 0 and 4
    expect(playNote).toHaveBeenCalledTimes(2);
  });

  it('releases the previous note before triggering the next, and gates the note', () => {
    const { clock, bus, arp, playNote, releaseNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(0);
    arp.setGate(0.5);
    bus.noteOn(60);
    bus.noteOn(64);

    clock.fireTick(0); // play 60, schedule its release at 0 + 0.125*0.5
    expect(playNote).toHaveBeenLastCalledWith(60, 0.85, 0);
    expect(releaseNote).toHaveBeenCalledWith(60, 0.0625);

    clock.fireTick(0.125); // release the held 60 at `when`, then play 64
    expect(releaseNote).toHaveBeenCalledWith(60, 0.125);
    expect(playNote).toHaveBeenLastCalledWith(64, 0.85, 0.125);
  });
});

// arpeggiator.md REQ-6. The clock only ticks in 16ths, so 1/32 used to fall into
// an `else` branch that fired once per tick and called itself "sample-accurate
// enough" — which made it play exactly 1/16. The dropdown offered a rate that
// changed nothing.
describe('Arpeggiator sub-16th rates (REQ-6)', () => {
  const SIXTEENTH = 0.125; // TestClock at 120 BPM

  it('schedules two hits per tick at 1/32, a half-sixteenth apart', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true);
    arp.setPattern(0); // up
    arp.setRate(3);    // 1/32 → division 0.5
    bus.noteOn(60);
    bus.noteOn(64);

    clock.fireTick(0);
    expect(played(playNote)).toEqual([60, 64]);
    expect(playNote.mock.calls[0]![2]).toBe(0);
    expect(playNote.mock.calls[1]![2]).toBeCloseTo(SIXTEENTH / 2, 10);
  });

  it('plays twice as many notes as 1/16 over the same ticks (regression)', () => {
    const sixteenth = setup();
    sixteenth.arp.setEnabled(true);
    sixteenth.arp.setRate(2); // 1/16
    sixteenth.bus.noteOn(60);
    sixteenth.clock.fireTicks(4);

    const thirtysecond = setup();
    thirtysecond.arp.setEnabled(true);
    thirtysecond.arp.setRate(3); // 1/32
    thirtysecond.bus.noteOn(60);
    thirtysecond.clock.fireTicks(4);

    expect(sixteenth.playNote).toHaveBeenCalledTimes(4);
    expect(thirtysecond.playNote).toHaveBeenCalledTimes(8);
  });

  it('gates against the 1/32 step, not the 1/16 it is nested in', () => {
    const { clock, bus, arp, releaseNote } = setup();
    arp.setEnabled(true);
    arp.setRate(3);   // 1/32 → stepDur 0.0625
    arp.setGate(0.5);
    bus.noteOn(60);

    clock.fireTick(0);
    // First hit at t=0 holds for 0.0625 * 0.5 — half of what a 1/16 gate gives.
    expect(releaseNote).toHaveBeenCalledWith(60, 0.03125);
  });
});

// arpeggiator.md REQ-7 — this is the design, not a defect. A song saves arp.on
// to *arm* the arp for a player; the sequencer deliberately does not feed it.
describe('Arpeggiator armed by a song (REQ-7)', () => {
  it('sounds nothing while no key is held, then arpeggiates when one is', () => {
    const { clock, bus, arp, playNote } = setup();
    arp.setEnabled(true); // as a loaded song's arp.on: 1 would
    clock.fireStart();    // the song plays

    clock.fireTicks(8);
    expect(playNote).not.toHaveBeenCalled();

    bus.noteOn(60); // the player joins in over the running song
    clock.fireTicks(2);
    expect(played(playNote)).toEqual([60, 60]);
  });
});
