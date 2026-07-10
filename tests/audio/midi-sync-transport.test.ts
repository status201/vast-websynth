import { describe, it, expect, vi } from 'vitest';
import { MidiSyncTransport } from '../../src/audio/midi-sync-transport';
import { makeFakeMidiAccess } from './fake-midi-access';
import type { SyncMessage } from '../../src/audio/transport/sync/sync-types';

describe('MidiSyncTransport', () => {
  it('broadcasts each message as its real-time byte to every output', () => {
    const { access, outputs } = makeFakeMidiAccess(0, 2);
    const t = new MidiSyncTransport(access);
    t.send({ type: 'start' });
    t.send({ type: 'pulse' }, 123.5);
    t.send({ type: 'stop' });
    for (const out of outputs) {
      expect(out.send).toHaveBeenNthCalledWith(1, [0xfa], undefined);
      expect(out.send).toHaveBeenNthCalledWith(2, [0xf8], 123.5);
      expect(out.send).toHaveBeenNthCalledWith(3, [0xfc], undefined);
    }
  });

  it('maps a song position to a 0xF2 3-byte message on every output', () => {
    const { access, outputs } = makeFakeMidiAccess(0, 2);
    const t = new MidiSyncTransport(access);
    t.send({ type: 'songposition', beat: 300 }, 5); // 300 = (msb 2 << 7) | lsb 44
    for (const out of outputs) {
      expect(out.send).toHaveBeenCalledWith([0xf2, 300 & 0x7f, (300 >> 7) & 0x7f], 5);
    }
  });

  it('drops tempo (no MIDI byte — MIDI carries tempo implicitly in pulse spacing)', () => {
    const { access, outputs } = makeFakeMidiAccess(0, 2);
    const t = new MidiSyncTransport(access);
    t.send({ type: 'tempo', bpm: 128 });
    for (const out of outputs) expect(out.send).not.toHaveBeenCalled();
  });

  it('surfaces an incoming song position (handleSongPosition) with its timestamp', () => {
    const { access } = makeFakeMidiAccess();
    const t = new MidiSyncTransport(access);
    const seen: Array<{ msg: SyncMessage; at: number }> = [];
    t.onMessage((msg, at) => seen.push({ msg, at }));
    t.handleSongPosition(300, 9);
    expect(seen).toEqual([{ msg: { type: 'songposition', beat: 300 }, at: 9 }]);
  });

  it('survives an output whose send throws (port unplugged mid-send)', () => {
    const { access, outputs } = makeFakeMidiAccess(0, 2);
    outputs[0]!.send.mockImplementation(() => { throw new Error('disconnected'); });
    const t = new MidiSyncTransport(access);
    expect(() => t.send({ type: 'start' })).not.toThrow();
    expect(outputs[1]!.send).toHaveBeenCalledWith([0xfa], undefined); // others still reached
  });

  it('maps incoming real-time bytes to messages with their timestamp', () => {
    const { access } = makeFakeMidiAccess();
    const t = new MidiSyncTransport(access);
    const seen: Array<{ msg: SyncMessage; at: number }> = [];
    t.onMessage((msg, at) => seen.push({ msg, at }));
    t.handleRealtimeByte(0xfa, 1);
    t.handleRealtimeByte(0xf8, 2);
    t.handleRealtimeByte(0xfb, 3);
    t.handleRealtimeByte(0xfc, 4);
    expect(seen).toEqual([
      { msg: { type: 'start' }, at: 1 },
      { msg: { type: 'pulse' }, at: 2 },
      { msg: { type: 'continue' }, at: 3 },
      { msg: { type: 'stop' }, at: 4 },
    ]);
  });

  it('ignores unknown real-time bytes (active sensing, reset)', () => {
    const { access } = makeFakeMidiAccess();
    const t = new MidiSyncTransport(access);
    const cb = vi.fn();
    t.onMessage(cb);
    t.handleRealtimeByte(0xfe, 0); // active sensing
    t.handleRealtimeByte(0xff, 0); // reset
    expect(cb).not.toHaveBeenCalled();
  });

  it('reports port counts and notifies on refreshPorts', () => {
    const { access } = makeFakeMidiAccess(2, 1);
    const t = new MidiSyncTransport(access);
    expect(t.ports()).toEqual({ ins: 2, outs: 1 });
    const cb = vi.fn();
    const un = t.onPortsChange(cb);
    t.refreshPorts();
    expect(cb).toHaveBeenCalledTimes(1);
    un();
    t.refreshPorts();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('onMessage unsubscribe stops delivery', () => {
    const { access } = makeFakeMidiAccess();
    const t = new MidiSyncTransport(access);
    const cb = vi.fn();
    const un = t.onMessage(cb);
    un();
    t.handleRealtimeByte(0xfa, 0);
    expect(cb).not.toHaveBeenCalled();
  });
});
