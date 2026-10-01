// Which MIDI channel plays the synth (input-control.md REQ-the-midi-input-channel-is-selectable).
//
// Device-scoped, like the sync mode: it describes the rig this browser is
// plugged into, not the song, so it is a remembered setting rather than a bus
// param that presets and songs would carry. A leaf module, so `midi.ts` (audio)
// and the Sync section (UI) both reach it without reaching each other.

/** MIDI channel 10 (1-based) — the General MIDI drum channel; it plays the sampler. */
export const DRUM_CHANNEL = 10;

/** `0` = omni (every channel but 10), else a 1-based channel other than 10. */
export type MidiInputChannel = number;

const KEY = 'websynth.midi.channel';
let current: MidiInputChannel | null = null;
const listeners = new Set<(ch: MidiInputChannel) => void>();

/** A stored value is untrusted (tampered storage): anything but a valid channel is omni. */
function valid(n: number): MidiInputChannel {
  return Number.isInteger(n) && n >= 1 && n <= 16 && n !== DRUM_CHANNEL ? n : 0;
}

export function midiInputChannel(): MidiInputChannel {
  if (current === null) {
    let stored = 0;
    try { stored = Number(localStorage.getItem(KEY) ?? 0); } catch { /* storage blocked */ }
    current = valid(stored);
  }
  return current;
}

export function setMidiInputChannel(ch: MidiInputChannel): void {
  current = valid(ch);
  try { localStorage.setItem(KEY, String(current)); } catch { /* storage blocked: session-only */ }
  for (const l of listeners) l(current);
}

export function onMidiInputChannelChange(fn: (ch: MidiInputChannel) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test seam: forget the cached value so the next read goes back to storage. */
export function resetMidiInputChannelForTests(): void {
  current = null;
}
