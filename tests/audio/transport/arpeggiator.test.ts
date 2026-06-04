import { describe, it, expect, vi } from 'vitest';
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
