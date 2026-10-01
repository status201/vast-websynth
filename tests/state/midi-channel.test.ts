// input-control.md REQ-the-midi-input-channel-is-selectable — a remembered, device-scoped
// setting whose stored value is untrusted.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  midiInputChannel, setMidiInputChannel, onMidiInputChannelChange, resetMidiInputChannelForTests,
} from '../../src/state/midi-channel';
import { installLocalStorageMock } from '../storage-mock';

beforeEach(() => {
  installLocalStorageMock();
  resetMidiInputChannelForTests();
});

describe('MIDI input channel', () => {
  it('defaults to omni', () => {
    expect(midiInputChannel()).toBe(0);
  });

  it('is remembered across a reload', () => {
    setMidiInputChannel(5);
    resetMidiInputChannelForTests();
    expect(midiInputChannel()).toBe(5);
  });

  it('reads a stored 10, an out-of-range or a junk value as omni', () => {
    for (const junk of ['10', '99', '0.5', 'abc', '-3']) {
      localStorage.setItem('websynth.midi.channel', junk);
      resetMidiInputChannelForTests();
      expect(midiInputChannel()).toBe(0);
    }
  });

  it('tells listeners about a change', () => {
    const seen = vi.fn();
    const off = onMidiInputChannelChange(seen);
    setMidiInputChannel(3);
    off();
    setMidiInputChannel(4);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(3);
  });
});
