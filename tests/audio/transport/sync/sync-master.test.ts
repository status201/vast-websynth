import { describe, it, expect, vi, afterEach } from 'vitest';
import { Clock } from '../../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../../src/audio/transport/tick-timer';
import { SyncMaster } from '../../../../src/audio/transport/sync/sync-master';
import type { SyncMessage } from '../../../../src/audio/transport/sync/sync-types';

type Sent = Array<{ msg: SyncMessage; atMs: number | undefined }>;

/**
 * Same two-fake-clocks setup as clock.test.ts: a mutable `currentTime` plus
 * Vitest fake timers. `toPerfMs` maps AudioContext seconds to a synthetic
 * perf-ms domain 1:1000 so pulse timestamps are directly assertable. The idle
 * clock gets an injected `TimeoutTimer` + a mutable `nowMs` so it is
 * deterministic.
 */
function setup(swing = 0) {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 } as unknown as AudioContext;
  const clock = new Clock(ctx, { timer: new TimeoutTimer() });
  clock.setBpm(120); // one 16th = 0.125 s; one pulse = 125/6 ms
  clock.setSwing(swing);
  const sent: Sent = [];
  const idleTimer = new TimeoutTimer();
  let now = 0;
  // `wire` logs sends and flushes in call order so REQ-18 ordering is assertable.
  const wire: string[] = [];
  const master = new SyncMaster(
    clock,
    (msg, atMs) => { sent.push({ msg, atMs }); wire.push(msg.type); },
    (t) => t * 1000,
    { timer: idleTimer, nowMs: () => now, flush: () => wire.push('flush') },
  );
  const advance = (audioS: number) => {
    (ctx as unknown as { currentTime: number }).currentTime += audioS;
    vi.advanceTimersByTime(25);
  };
  // Advance the idle clock one wakeup (100 ms) at a time, bumping the injected now.
  const idleStep = () => { now += 100; vi.advanceTimersByTime(100); };
  return { clock, master, sent, wire, advance, idleStep };
}

afterEach(() => {
  vi.useRealTimers();
});

const pulses = (sent: Sent) => sent.filter((s) => s.msg.type === 'pulse');
const types = (sent: Sent) => sent.map((s) => s.msg.type);

describe('SyncMaster', () => {
  it('emits start then 24-PPQN pulses spaced 60000/(bpm*24) ms apart', () => {
    const { clock, master, sent, advance } = setup();
    master.enable();
    clock.start(); // step 0 drains synchronously
    // v2: enable-while-stopped announces tempo first; the transport 'start' is next.
    expect(types(sent).find((t) => t !== 'tempo')).toBe('start');

    advance(0.125); // step 1 (odd — no pulses)
    advance(0.125); // step 2 (even — next 12)
    const p = pulses(sent);
    expect(p.length).toBe(24); // steps 0 and 2, 12 each
    const spacing = 125 / 6;
    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.atMs! - p[i - 1]!.atMs!).toBeCloseTo(spacing, 6);
    }
    // First pulse rides the grid: step 0 is scheduled at +0.05 s.
    expect(p[0]!.atMs!).toBeCloseTo(50, 6);
  });

  it('sends a straight (unswung) pulse grid even at max swing', () => {
    const { clock, master, sent, advance } = setup(1);
    master.enable();
    clock.start();
    advance(0.125);
    advance(0.125);
    const p = pulses(sent);
    expect(p.length).toBe(24);
    for (let i = 1; i < p.length; i++) {
      expect(p[i]!.atMs! - p[i - 1]!.atMs!).toBeCloseTo(125 / 6, 6); // no swing bump
    }
  });

  it('emits an explicit tempo on start', () => {
    const { clock, master, sent } = setup();
    master.enable();
    sent.length = 0;
    clock.start();
    const tempo = sent.find((s) => s.msg.type === 'tempo');
    expect(tempo?.msg).toEqual({ type: 'tempo', bpm: 120 });
  });

  it('broadcasts stop on any clock stop', () => {
    const { clock, master, sent } = setup();
    master.enable();
    clock.start();
    clock.stop();
    expect(sent[sent.length - 1]!.msg.type).toBe('stop');
  });

  it('enabling mid-play announces tempo + song position + continue (not a bare start)', () => {
    const { clock, master, sent } = setup();
    clock.start();          // playing already (master not yet enabled)
    sent.length = 0;
    master.enable();        // becomes master mid-play
    expect(types(sent)).toEqual(['tempo', 'songposition', 'continue']);
    expect(types(sent)).not.toContain('start'); // would restart locked slaves at bar 0
  });

  it('announce carries the current song position (step & 0x3fff)', () => {
    const { clock, master, sent } = setup();
    clock.start();
    // Drain a couple of bars so the step is nonzero.
    (clock as unknown as { _step: number })._step = 40;
    sent.length = 0;
    master.enable();
    const sp = sent.find((s) => s.msg.type === 'songposition');
    expect(sp?.msg).toEqual({ type: 'songposition', beat: 40 });
  });

  it('runs an idle clock while enabled and stopped (warms slaves before Start)', () => {
    const { master, sent, idleStep } = setup();
    master.enable(); // clock stopped
    expect(sent[0]!.msg.type).toBe('tempo'); // tempo announced on enable
    sent.length = 0;
    for (let i = 0; i < 12; i++) idleStep(); // ~1.2 s of idle wakeups
    const p = pulses(sent);
    expect(p.length).toBeGreaterThan(30); // ~48 pulses/s at 120 BPM
    // idle pulses carry (perf-domain) timestamps, spaced ~one 24-PPQN interval.
    const spacing = 125 / 6;
    for (let i = 1; i < p.length; i++) {
      const dt = p[i]!.atMs! - p[i - 1]!.atMs!;
      expect(dt).toBeGreaterThan(0);
      expect(dt).toBeLessThan(spacing * 1.5);
    }
  });

  it('emits a tempo heartbeat every ~2 s while idle', () => {
    const { master, sent, idleStep } = setup();
    master.enable();
    sent.length = 0;
    for (let i = 0; i < 22; i++) idleStep(); // > 2 s
    expect(sent.some((s) => s.msg.type === 'tempo')).toBe(true);
  });

  it('stops the idle clock on start (no idle pulses once playing)', () => {
    const { clock, master, sent, idleStep } = setup();
    master.enable();
    clock.start(); // stops idle
    sent.length = 0;
    idleStep(); // idle timer is stopped — nothing scheduled
    expect(sent.length).toBe(0);
    clock.stop();
  });

  it('flushes scheduled sends before start and stop, never around announceTo (REQ-18)', () => {
    const { clock, master, wire, idleStep } = setup();
    master.enable(); // stopped -> idle clock queues future-timestamped pulses
    idleStep();
    wire.length = 0;
    clock.start();
    // The queued idle tail is dropped before 0xFA hits the wire.
    expect(wire.indexOf('flush')).toBeGreaterThanOrEqual(0);
    expect(wire.indexOf('flush')).toBeLessThan(wire.indexOf('start'));
    wire.length = 0;
    clock.stop();
    // Same for the queued run tail vs 0xFC.
    expect(wire.indexOf('flush')).toBeGreaterThanOrEqual(0);
    expect(wire.indexOf('flush')).toBeLessThan(wire.indexOf('stop'));
    // announceTo must NOT flush — a global clear would cancel in-flight run
    // pulses that already-locked slaves still need.
    clock.start();
    wire.length = 0;
    master.announceTo((msg) => wire.push(msg.type));
    expect(wire).not.toContain('flush');
    clock.stop();
  });

  it('disabling mid-play sends stop (no silently free-running slaves)', () => {
    const { clock, master, sent } = setup();
    master.enable();
    clock.start();
    master.disable();
    expect(sent[sent.length - 1]!.msg.type).toBe('stop');
    // And it is really unhooked: another transport cycle emits nothing new.
    const n = sent.length;
    clock.stop();
    clock.start();
    expect(sent.length).toBe(n);
  });
});
