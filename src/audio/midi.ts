import type { Engine } from './engine';
import type { ParamBus } from '../state/params';
import { MidiSyncTransport } from './midi-sync-transport';
import { SustainPedal } from './sustain-pedal';

export async function initMIDI(engine: Engine, bus: ParamBus): Promise<void> {
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
    // This module is the sole owner of the MIDIAccess handler properties
    // (onmidimessage/onstatechange are single-assignment); the sync transport
    // is *fed* from here rather than wiring its own handlers.
    const sync = new MidiSyncTransport(access);
    engine.sync.addTransport('midi', sync);
    const pedal = new SustainPedal();
    const wire = (input: MIDIInput) => {
      input.onmidimessage = (ev: MIDIMessageEvent) => handleMessage(ev, bus, sync, pedal);
    };
    access.inputs.forEach(wire);
    access.onstatechange = () => {
      access.inputs.forEach(wire);
      sync.refreshPorts();
    };
  } catch (err) {
    console.warn('[MIDI] requestMIDIAccess failed:', err);
  }
}

function handleMessage(ev: MIDIMessageEvent, bus: ParamBus, sync: MidiSyncTransport, pedal: SustainPedal): void {
  const data = ev.data;
  if (!data || data.length < 1) return;
  // System Real-Time (0xF8..0xFF) first: single-byte messages that must never
  // reach the channel-voice mask below (0xF8 & 0xF0 = 0xF0 would mis-dispatch).
  if (data[0]! >= 0xf8) {
    sync.handleRealtimeByte(data[0]!, ev.timeStamp);
    return;
  }
  // Song Position Pointer (0xF2, System Common, 3 bytes): a slave joining
  // mid-song seeks to this beat. Routed before the & 0xf0 mask (midi-clock-sync
  // REQ-10); 14-bit beat = (msb << 7) | lsb, one beat = 6 clocks = one 16th.
  if (data[0] === 0xf2) {
    sync.handleSongPosition(((data[2] ?? 0) << 7) | (data[1] ?? 0), ev.timeStamp);
    return;
  }
  const status = data[0]! & 0xf0;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;

  switch (status) {
    case 0x90: // Note on (vel 0 = note off, so it obeys the pedal too)
      if (d2 === 0) noteOff(d1, bus, pedal);
      else {
        pedal.noteOn(d1);
        bus.noteOn(d1, d2 / 127);
      }
      break;
    case 0x80: // Note off
      noteOff(d1, bus, pedal);
      break;
    case 0xb0: // CC
      handleCC(d1, d2, bus, pedal);
      break;
    case 0xe0: // Pitch bend
      {
        const raw = (d2 << 7) | d1; // 0..16383, 8192 = center
        bus.set('master.pitchBend', (raw - 8192) / 8192);
      }
      break;
  }
}

/** A note-off routed through the sustain pedal (input-control.md REQ-8):
 *  deferred while the pedal is down, delivered otherwise. */
function noteOff(note: number, bus: ParamBus, pedal: SustainPedal): void {
  if (pedal.noteOff(note)) bus.noteOff(note);
}

function handleCC(cc: number, value: number, bus: ParamBus, pedal: SustainPedal): void {
  const n = value / 127;
  switch (cc) {
    case 1: bus.set('master.modWheel', n); break;
    case 7: bus.set('master.volume', n); break;
    case 64: // Sustain pedal: >= 64 down; release flushes deferred note-offs
      for (const note of pedal.setPedal(value >= 64)) bus.noteOff(note);
      break;
    case 71: bus.set('filter.resonance', n * 4.2); break;
    case 74: bus.set('filter.cutoff', 30 + n * 100); break;
  }
}
