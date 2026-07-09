import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Clock } from '../../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../../src/audio/transport/tick-timer';
import { SyncController } from '../../../../src/audio/transport/sync/sync-controller';
import type { SyncMessage, SyncTransport } from '../../../../src/audio/transport/sync/sync-types';
import { installLocalStorageMock } from '../../../storage-mock';

class FakeTransport implements SyncTransport {
  sent: Array<{ msg: SyncMessage; atMs: number | undefined }> = [];
  private readonly cbs = new Set<(msg: SyncMessage, at: number) => void>();
  send(msg: SyncMessage, atMs?: number): void { this.sent.push({ msg, atMs }); }
  onMessage(cb: (msg: SyncMessage, at: number) => void): () => void {
    this.cbs.add(cb);
    return () => { this.cbs.delete(cb); };
  }
  emit(msg: SyncMessage, at = 0): void { for (const cb of this.cbs) cb(msg, at); }
  ports() { return { ins: 1, outs: 1 }; }
  onPortsChange(): () => void { return () => {}; }
}

function setup(persist = false) {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 } as unknown as AudioContext;
  const clock = new Clock(ctx, { timer: new TimeoutTimer() });
  clock.setBpm(120);
  const ctrl = new SyncController(clock, {
    toPerfMs: (t) => t * 1000,
    toAudioTime: (ms) => ms / 1000,
    localBpm: () => 120,
    persist,
  });
  const transport = new FakeTransport();
  return { clock, ctrl, transport };
}

let store: Map<string, string>;

beforeEach(() => {
  store = installLocalStorageMock();
});

afterEach(() => {
  vi.useRealTimers();
});

const clockBpm = (clock: Clock): number => 15 / clock.sixteenthDuration();
const intervalMs = (bpm: number): number => 60000 / (bpm * 24);

describe('SyncController', () => {
  it('mode off ignores incoming messages (the gate)', () => {
    const { clock, ctrl, transport } = setup();
    ctrl.attachTransport(transport);
    transport.emit({ type: 'start' });
    expect(clock.playing).toBe(false);
    expect(ctrl.mode).toBe('off');
  });

  it('mode master ignores incoming messages (no feedback loops)', () => {
    const { clock, ctrl, transport } = setup();
    ctrl.attachTransport(transport);
    ctrl.setMode('master');
    transport.emit({ type: 'start' });
    expect(clock.playing).toBe(false);
  });

  it('mode slave follows incoming start/stop', () => {
    const { clock, ctrl, transport } = setup();
    ctrl.attachTransport(transport);
    ctrl.setMode('slave');
    transport.emit({ type: 'start' });
    expect(clock.playing).toBe(true);
    transport.emit({ type: 'stop' });
    expect(clock.playing).toBe(false);
  });

  it('mode master broadcasts local transport + pulses through the wire', () => {
    const { clock, ctrl, transport } = setup();
    ctrl.attachTransport(transport);
    ctrl.setMode('master');
    clock.start();
    clock.stop();
    const types = transport.sent.map((s) => s.msg.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('pulse');
    expect(types[types.length - 1]).toBe('stop');
  });

  it('leaving slave mode restores the knob tempo', () => {
    const { clock, ctrl, transport } = setup();
    ctrl.attachTransport(transport);
    ctrl.setMode('slave');
    transport.emit({ type: 'start' });
    const dt = intervalMs(140);
    for (let i = 0; i < 48; i++) transport.emit({ type: 'pulse' }, i * dt);
    expect(Math.abs(clockBpm(clock) - 140)).toBeLessThan(0.5);
    ctrl.setMode('off');
    expect(clockBpm(clock)).toBeCloseTo(120, 6);
  });

  it('is inert but switchable before a transport is attached (REQ-9)', () => {
    const { clock, ctrl, transport } = setup();
    ctrl.setMode('master');
    expect(ctrl.status.ports).toBeNull();
    expect(() => clock.start()).not.toThrow(); // sends go nowhere, no crash
    clock.stop();
    ctrl.attachTransport(transport); // late attach re-arms the same role
    expect(ctrl.status.ports).toEqual({ ins: 1, outs: 1 });
    clock.start();
    expect(transport.sent.some((s) => s.msg.type === 'start')).toBe(true);
  });

  it('persists the mode under websynth.midisync and restores it', () => {
    const { ctrl } = setup(true);
    ctrl.setMode('slave');
    expect(store.get('websynth.midisync')).toBe('slave');
    const { ctrl: reborn } = setup(true); // fresh controller, same storage
    expect(reborn.mode).toBe('slave');
  });

  it('emits status on mode changes and transport edges', () => {
    const { clock, ctrl, transport } = setup();
    ctrl.attachTransport(transport);
    const seen: string[] = [];
    ctrl.onStatus((s) => seen.push(`${s.mode}:${s.playing ? 'play' : 'stop'}`));
    ctrl.setMode('master');
    clock.start();
    clock.stop();
    expect(seen).toContain('master:play');
    expect(seen[seen.length - 1]).toBe('master:stop');
  });
});
