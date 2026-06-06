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
