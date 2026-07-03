import type { Engine } from './engine';
import type { ParamBus } from '../state/params';

export async function initMIDI(_engine: Engine, bus: ParamBus): Promise<void> {
  const nav = navigator as unknown as {
    requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess>;
  };
  if (!nav.requestMIDIAccess) {
    console.info('[MIDI] Web MIDI not available in this browser.');
    return;
  }
  try {
    // Explicit non-sysex request; the browser may still show a permission
    // prompt (Chrome ≥124 gates all MIDI access) — denial lands in the catch.
    const access = await nav.requestMIDIAccess({ sysex: false });
    const wire = (input: MIDIInput) => {
      input.onmidimessage = (ev: MIDIMessageEvent) => handleMessage(ev, bus);
    };
    access.inputs.forEach(wire);
    access.onstatechange = () => access.inputs.forEach(wire);
  } catch (err) {
    console.warn('[MIDI] requestMIDIAccess failed:', err);
  }
}

function handleMessage(ev: MIDIMessageEvent, bus: ParamBus): void {
  const data = ev.data;
  if (!data || data.length < 1) return;
  const status = data[0]! & 0xf0;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;

  switch (status) {
    case 0x90: // Note on
      if (d2 === 0) bus.noteOff(d1);
      else bus.noteOn(d1, d2 / 127);
      break;
    case 0x80: // Note off
      bus.noteOff(d1);
      break;
    case 0xb0: // CC
      handleCC(d1, d2, bus);
      break;
    case 0xe0: // Pitch bend
      {
        const raw = (d2 << 7) | d1; // 0..16383, 8192 = center
        bus.set('master.pitchBend', (raw - 8192) / 8192);
      }
      break;
  }
}

function handleCC(cc: number, value: number, bus: ParamBus): void {
  const n = value / 127;
  switch (cc) {
    case 1: bus.set('master.modWheel', n); break;
    case 7: bus.set('master.volume', n); break;
    case 71: bus.set('filter.resonance', n * 4.2); break;
    case 74: bus.set('filter.cutoff', 30 + n * 100); break;
  }
}

