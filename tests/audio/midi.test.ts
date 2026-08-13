import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initMIDI } from '../../src/audio/midi';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { MidiSyncTransport } from '../../src/audio/midi-sync-transport';
import { makeFakeMidiAccess, type FakeMidiAccess, type FakeMidiInput } from './fake-midi-access';
import type { Engine } from '../../src/audio/engine';
import type { SyncMessage } from '../../src/audio/transport/sync/sync-types';

/**
 * `midi.ts` — the raw-byte ingest surface (input-control.md REQ-4/REQ-7/REQ-8,
 * midi-clock-sync.md REQ-10). `handleMessage` is module-private on purpose, so
 * every case here drives it the way a device does: through `initMIDI`, which
 * assigns `onmidimessage` on each port, then feeding bytes into that handler.
 *
 * The sync transport is the real `MidiSyncTransport` captured from the engine's
 * `addTransport` call and observed through its own `onMessage`/`onPortsChange`
 * listeners — no module mocking, so the routing under test is the shipped one.
 */

interface Rig {
  bus: ParamBus;
  notes: Array<{ on: boolean; note: number; velocity: number }>;
  sync: MidiSyncTransport;
  syncMsgs: Array<{ msg: SyncMessage; at: number }>;
  portChanges: () => number;
  midi: FakeMidiAccess;
  input: FakeMidiInput;
  addTransport: ReturnType<typeof vi.fn>;
}

/** A bus with the real catalogue, so the CC map meets the real param ranges. */
function newBus(): ParamBus {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
}

/** Stub `navigator.requestMIDIAccess` — jsdom has no Web MIDI at all. */
function stubRequest(impl: ((options?: { sysex?: boolean }) => Promise<MIDIAccess>) | undefined): void {
  if (impl === undefined) {
    Reflect.deleteProperty(navigator, 'requestMIDIAccess');
    return;
  }
  Object.defineProperty(navigator, 'requestMIDIAccess', { value: impl, configurable: true, writable: true });
}

async function makeRig(ins = 1): Promise<Rig> {
  const midi = makeFakeMidiAccess(ins, 1);
  stubRequest(() => Promise.resolve(midi.access));

  const bus = newBus();
  const notes: Rig['notes'] = [];
  bus.onNote((on, note, velocity) => notes.push({ on, note, velocity }));

  const addTransport = vi.fn();
  const engine = { sync: { addTransport } } as unknown as Engine;
  const access = await initMIDI(engine, bus);
  expect(access).toBe(midi.access);

  const sync = addTransport.mock.calls[0]![1] as MidiSyncTransport;
  const syncMsgs: Rig['syncMsgs'] = [];
  sync.onMessage((msg, at) => syncMsgs.push({ msg, at }));
  let ports = 0;
  sync.onPortsChange(() => { ports++; });

  return { bus, notes, sync, syncMsgs, portChanges: () => ports, midi, input: midi.inputs[0]!, addTransport };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  stubRequest(undefined);
  vi.restoreAllMocks();
});

describe('initMIDI wiring (input-control.md REQ-7)', () => {
  it('registers exactly one sync transport, bound to the shared access', async () => {
    const r = await makeRig(2);
    expect(r.addTransport).toHaveBeenCalledTimes(1);
    expect(r.addTransport.mock.calls[0]![0]).toBe('midi');
    expect(r.sync).toBeInstanceOf(MidiSyncTransport);
    // Bound to the same handle the caller got back, not a second request.
    expect(r.sync.ports()).toEqual({ ins: 2, outs: 1 });
  });

  it('owns onmidimessage on every port present at init', async () => {
    const r = await makeRig(2);
    for (const input of r.midi.inputs) expect(input.onmidimessage).toBeTypeOf('function');
  });

  it('wires a port that arrives later and refreshes the port counts', async () => {
    const r = await makeRig(1);
    expect(r.portChanges()).toBe(0);

    const late = r.midi.plugInput(); // fires statechange, as a real hot-plug does
    expect(late.onmidimessage).toBeTypeOf('function');
    expect(r.portChanges()).toBe(1);

    // And the newly-wired port really reaches the bus.
    late.receive([0x90, 64, 100]);
    expect(r.notes).toEqual([{ on: true, note: 64, velocity: 100 / 127 }]);
  });

  it('is a silent no-op when the browser has no Web MIDI', async () => {
    stubRequest(undefined);
    const addTransport = vi.fn();
    const engine = { sync: { addTransport } } as unknown as Engine;
    await expect(initMIDI(engine, newBus())).resolves.toBeNull();
    expect(addTransport).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalled();
  });

  it('is a logged no-op when the permission prompt is denied', async () => {
    stubRequest(() => Promise.reject(new DOMException('denied', 'SecurityError')));
    const addTransport = vi.fn();
    const engine = { sync: { addTransport } } as unknown as Engine;
    await expect(initMIDI(engine, newBus())).resolves.toBeNull();
    expect(addTransport).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('channel-voice messages', () => {
  it('note-on carries a normalized velocity; note-off releases', async () => {
    const r = await makeRig();
    r.input.receive([0x90, 60, 100]);
    r.input.receive([0x80, 60, 0]);
    expect(r.notes).toEqual([
      { on: true, note: 60, velocity: 100 / 127 },
      { on: false, note: 60, velocity: 0 },
    ]);
  });

  it('reads the channel nibble as part of the status, so channel 16 plays too', async () => {
    const r = await makeRig();
    r.input.receive([0x9f, 72, 127]); // note-on, channel 16
    expect(r.notes).toEqual([{ on: true, note: 72, velocity: 1 }]);
  });

  // input-control.md REQ-4 — the edge every controller relies on.
  it('note-on with velocity 0 is a note-off', async () => {
    const r = await makeRig();
    r.input.receive([0x90, 60, 0]);
    expect(r.notes).toEqual([{ on: false, note: 60, velocity: 0 }]);
  });

  it('pitch bend reassembles the 14-bit value around a centred 8192', async () => {
    const r = await makeRig();
    r.input.receive([0xe0, 0x00, 0x40]); // centre
    expect(r.bus.get('master.pitchBend')).toBe(0);
    r.input.receive([0xe0, 0x00, 0x00]); // fully down
    expect(r.bus.get('master.pitchBend')).toBe(-1);
    r.input.receive([0xe0, 0x7f, 0x7f]); // fully up (16383 is one step shy of +1)
    expect(r.bus.get('master.pitchBend')).toBeCloseTo(1, 3);
  });
});

describe('control change map', () => {
  it('CC1 and CC7 write the mod wheel and master volume across their full range', async () => {
    const r = await makeRig();
    r.input.receive([0xb0, 1, 127]);
    r.input.receive([0xb0, 7, 0]);
    expect(r.bus.get('master.modWheel')).toBe(1);
    expect(r.bus.get('master.volume')).toBe(0);
  });

  // The two filter CCs are scaled to land exactly on each param's own range —
  // no clamping, so a controller reaches both ends. Cutoff is a MIDI NOTE
  // NUMBER (ADR-005), which is why the map is `30 + n * 100` and not a Hz sweep.
  it('CC74 sweeps filter.cutoff across its full note range', async () => {
    const r = await makeRig();
    const def = r.bus.def('filter.cutoff')!;
    r.input.receive([0xb0, 74, 0]);
    expect(r.bus.get('filter.cutoff')).toBe(def.min);
    r.input.receive([0xb0, 74, 127]);
    expect(r.bus.get('filter.cutoff')).toBe(def.max);
  });

  it('CC71 sweeps filter.resonance across its full range', async () => {
    const r = await makeRig();
    const def = r.bus.def('filter.resonance')!;
    r.input.receive([0xb0, 71, 0]);
    expect(r.bus.get('filter.resonance')).toBe(def.min);
    r.input.receive([0xb0, 71, 127]);
    expect(r.bus.get('filter.resonance')).toBeCloseTo(def.max, 10);
  });

  it('ignores a CC nothing is mapped to', async () => {
    const r = await makeRig();
    const before = r.bus.snapshot();
    r.input.receive([0xb0, 22, 127]);
    expect(r.bus.snapshot()).toEqual(before);
    expect(r.notes).toEqual([]);
  });

  // input-control.md REQ-8 — the pedal integrated *through* midi.ts, which the
  // SustainPedal unit test cannot see: the note-off never reaches the bus until
  // CC64 is released.
  it('CC64 defers a note-off until the pedal comes up, then flushes it once', async () => {
    const r = await makeRig();
    r.input.receive([0x90, 60, 100]);
    r.input.receive([0xb0, 64, 127]); // pedal down
    r.input.receive([0x80, 60, 0]);   // key released, voice keeps ringing
    expect(r.notes.filter((n) => !n.on)).toEqual([]);

    r.input.receive([0xb0, 64, 0]);   // pedal up
    expect(r.notes.filter((n) => !n.on)).toEqual([{ on: false, note: 60, velocity: 0 }]);
  });

  // input-control.md: a velocity-0 note-on is a note-off *in disguise*, so it
  // has to take the deferral path too — the two are one branch in midi.ts, and
  // the pedal helper alone cannot show that they meet.
  it('a velocity-0 note-on obeys the pedal exactly like an 0x80 note-off', async () => {
    const r = await makeRig();
    r.input.receive([0x90, 60, 100]);
    r.input.receive([0xb0, 64, 127]); // pedal down
    r.input.receive([0x90, 60, 0]);   // note-off in disguise
    expect(r.notes.filter((n) => !n.on)).toEqual([]);

    r.input.receive([0xb0, 64, 0]);
    expect(r.notes.filter((n) => !n.on)).toEqual([{ on: false, note: 60, velocity: 0 }]);
  });

  it('reads value >= 64 as pedal down (no half-pedalling)', async () => {
    const r = await makeRig();
    r.input.receive([0x90, 60, 100]);
    r.input.receive([0xb0, 64, 63]); // still up
    r.input.receive([0x80, 60, 0]);
    expect(r.notes.filter((n) => !n.on)).toHaveLength(1);
  });
});

describe('system messages route before the channel mask', () => {
  // 0xF8 & 0xF0 === 0xF0, so a clock byte reaching the channel switch would
  // mis-dispatch. Each of these must leave the note/CC path completely untouched.
  it('a real-time clock byte goes to the sync transport only', async () => {
    const r = await makeRig();
    const before = r.bus.snapshot();
    r.input.receive([0xf8], 42);
    expect(r.syncMsgs).toEqual([{ msg: { type: 'pulse' }, at: 42 }]);
    expect(r.notes).toEqual([]);
    expect(r.bus.snapshot()).toEqual(before);
  });

  it('start / continue / stop reach the transport with their timestamps', async () => {
    const r = await makeRig();
    r.input.receive([0xfa], 1);
    r.input.receive([0xfb], 2);
    r.input.receive([0xfc], 3);
    expect(r.syncMsgs).toEqual([
      { msg: { type: 'start' }, at: 1 },
      { msg: { type: 'continue' }, at: 2 },
      { msg: { type: 'stop' }, at: 3 },
    ]);
    expect(r.notes).toEqual([]);
  });

  // midi-clock-sync.md REQ-10 — 0xF2 is System Common, below the 0xF8 floor, so
  // it needs its own branch ahead of the mask.
  it('a Song Position Pointer reassembles its 14-bit beat', async () => {
    const r = await makeRig();
    r.input.receive([0xf2, 44, 2], 7); // (2 << 7) | 44 === 300
    expect(r.syncMsgs).toEqual([{ msg: { type: 'songposition', beat: 300 }, at: 7 }]);
    expect(r.notes).toEqual([]);
  });

  it('ignores real-time bytes with no sync meaning (active sensing, reset)', async () => {
    const r = await makeRig();
    r.input.receive([0xfe]);
    r.input.receive([0xff]);
    expect(r.syncMsgs).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});

// untrusted-input.md — a device is an ingest surface, and nothing it sends may
// throw its way out of the handler.
describe('malformed input', () => {
  it('survives an empty or truncated message', async () => {
    const r = await makeRig();
    expect(() => r.input.receive([])).not.toThrow();
    expect(() => r.input.receive([0x90])).not.toThrow();
    expect(() => r.input.receive([0xb0, 74])).not.toThrow();
    expect(() => r.input.receive([0xf2, 44])).not.toThrow();
  });
});
