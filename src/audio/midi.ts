import type { Engine } from './engine';
import type { ParamBus } from '../state/params';
import { MidiSyncTransport } from './transport/sync/midi-sync-transport';
import { SustainPedal } from './sustain-pedal';
import { SAMPLER_SLOT_COUNT } from '../state/patterns';
import { DRUM_CHANNEL, midiInputChannel } from '../state/midi-channel';

/** The note that plays sampler slot 1 on channel 10 — C1, where GM kicks and pad banks start. */
const PAD_BASE_NOTE = 36;

/** The two inputs that share `master.modWheel` (REQ-aftertouch-joins-the-mod-wheel). */
interface ModSources { wheel: number; pressure: number }

/**
 * What each input port is holding, so its notes are released however they end
 * (input-control.md REQ-a-midi-note-is-released-by-whatever-ended-it): by a note-off on a channel the filter
 * has since dropped, or by the port going away. Keys are `channel * 128 + note`.
 */
interface PortHolds {
  sounding: Map<string, Set<number>>;
  /** The port that moved the pitch bend last — its departure re-centres it. */
  bendPort: string | null;
}

const holdKey = (channel: number, note: number): number => channel * 128 + note;

/**
 * Request Web MIDI and wire it up. Resolves the `MIDIAccess` on success (and
 * `null` when unavailable or denied) so `main.ts` can expose live port counts
 * to the Debug panel — the audio layer must never import UI, and this module
 * stays the sole owner of the handle.
 */
export async function initMIDI(engine: Engine, bus: ParamBus): Promise<MIDIAccess | null> {
  const nav = navigator as unknown as {
    requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess>;
  };
  if (!nav.requestMIDIAccess) {
    console.info('[MIDI] Web MIDI not available in this browser.');
    return null;
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
    const mod: ModSources = { wheel: 0, pressure: 0 };
    const holds: PortHolds = { sounding: new Map(), bendPort: null };
    const wire = (input: MIDIInput) => {
      input.onmidimessage = (ev: MIDIMessageEvent) =>
        handleMessage(ev, input.id, engine, bus, sync, pedal, mod, holds);
    };
    access.inputs.forEach(wire);
    access.onstatechange = () => {
      releaseVanishedPorts(access, bus, pedal, holds);
      access.inputs.forEach(wire);
      sync.refreshPorts();
    };
    return access;
  } catch (err) {
    console.warn('[MIDI] requestMIDIAccess failed:', err);
    return null;
  }
}

/**
 * Release whatever a port that has gone away was holding. Browsers differ on
 * whether an unplugged input leaves `access.inputs` or stays in it as
 * `disconnected`, so both count — and the live list is consulted rather than the
 * event's `port`, which tells nothing about a second port that left alongside.
 */
function releaseVanishedPorts(access: MIDIAccess, bus: ParamBus, pedal: SustainPedal, holds: PortHolds): void {
  for (const [portId, keys] of holds.sounding) {
    const port = access.inputs.get(portId);
    if (port && port.state !== 'disconnected') continue;
    holds.sounding.delete(portId);
    // Its pedal may have been the one down: lift it first, flushing what it
    // deferred, so the keys below are released once rather than deferred again.
    for (const note of pedal.setPedal(false)) bus.noteOff(note);
    for (const key of keys) {
      pedal.noteOff(key % 128);
      bus.noteOff(key % 128);
    }
    if (holds.bendPort === portId) {
      holds.bendPort = null;
      bus.set('master.pitchBend', 0);
    }
  }
}

function handleMessage(
  ev: MIDIMessageEvent,
  portId: string,
  engine: Engine,
  bus: ParamBus,
  sync: MidiSyncTransport,
  pedal: SustainPedal,
  mod: ModSources,
  holds: PortHolds,
): void {
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
  // REQ-song-position-pointer-jumps-the-slave); 14-bit beat = (msb << 7) | lsb, one beat = 6 clocks = one 16th.
  if (data[0] === 0xf2) {
    sync.handleSongPosition(((data[2] ?? 0) << 7) | (data[1] ?? 0), ev.timeStamp);
    return;
  }
  const status = data[0]! & 0xf0;
  const channel = (data[0]! & 0x0f) + 1; // 1-based, as players name channels
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;

  // Channel 10 is the sampler's pads and nothing else (input-control.md
  // REQ-channel-ten-plays-the-sampler): C1 upward are slots 1..8, velocity-sensitive.
  if (channel === DRUM_CHANNEL) {
    if (status === 0x90 && d2 > 0) {
      const slot = d1 - PAD_BASE_NOTE;
      if (slot >= 0 && slot < SAMPLER_SLOT_COUNT) engine.sampler.triggerSlot(slot, d2 / 127);
    }
    return;
  }
  // Every port that sends channel messages is remembered, notes or not, so one
  // that only bent the pitch still re-centres it when it goes.
  let held = holds.sounding.get(portId);
  if (!held) holds.sounding.set(portId, (held = new Set()));
  const isOff = status === 0x80 || (status === 0x90 && d2 === 0);
  // A note-off for a note this port sounded is honoured whatever the filter now
  // says — the channel may have changed since its note-on
  // (REQ-a-midi-note-is-released-by-whatever-ended-it).
  if (isOff && held.delete(holdKey(channel, d1))) {
    noteOff(d1, bus, pedal);
    return;
  }
  // The synth's channel (REQ-the-midi-input-channel-is-selectable): 0 is omni.
  const wanted = midiInputChannel();
  if (wanted !== 0 && channel !== wanted) return;

  switch (status) {
    case 0x90: // Note on (vel 0 = note off, so it obeys the pedal too)
      if (d2 === 0) noteOff(d1, bus, pedal);
      else {
        held.add(holdKey(channel, d1));
        pedal.noteOn(d1);
        bus.noteOn(d1, d2 / 127);
      }
      break;
    case 0x80: // Note off
      noteOff(d1, bus, pedal);
      break;
    case 0xb0: // CC
      handleCC(d1, d2, bus, pedal, mod);
      break;
    case 0xd0: // Channel pressure — shares the mod wheel (REQ-aftertouch-joins-the-mod-wheel)
      mod.pressure = d1 / 127;
      bus.set('master.modWheel', Math.max(mod.wheel, mod.pressure));
      break;
    case 0xe0: // Pitch bend
      {
        const raw = (d2 << 7) | d1; // 0..16383, 8192 = center
        bus.set('master.pitchBend', (raw - 8192) / 8192);
        holds.bendPort = portId;
      }
      break;
  }
}

/** A note-off routed through the sustain pedal (input-control.md REQ-the-sustain-pedal-is-midi-layer):
 *  deferred while the pedal is down, delivered otherwise. */
function noteOff(note: number, bus: ParamBus, pedal: SustainPedal): void {
  if (pedal.noteOff(note)) bus.noteOff(note);
}

function handleCC(cc: number, value: number, bus: ParamBus, pedal: SustainPedal, mod: ModSources): void {
  const n = value / 127;
  switch (cc) {
    case 1: // the larger of wheel and pressure wins (REQ-aftertouch-joins-the-mod-wheel)
      mod.wheel = n;
      bus.set('master.modWheel', Math.max(mod.wheel, mod.pressure));
      break;
    case 7: bus.set('master.volume', n); break;
    case 11: bus.set('master.expression', n); break; // REQ-cc11-is-expression
    case 64: // Sustain pedal: >= 64 down; release flushes deferred note-offs
      for (const note of pedal.setPedal(value >= 64)) bus.noteOff(note);
      break;
    case 71: bus.set('filter.resonance', n * 4.2); break;
    case 74: bus.set('filter.cutoff', 30 + n * 100); break;
  }
}
