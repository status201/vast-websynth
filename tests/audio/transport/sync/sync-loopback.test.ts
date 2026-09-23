import { describe, it, expect } from 'vitest';
import { Clock } from '../../../../src/audio/transport/clock';
import { SyncMaster } from '../../../../src/audio/transport/sync/sync-master';
import { SyncSlave } from '../../../../src/audio/transport/sync/sync-slave';
import type { SyncMessage } from '../../../../src/audio/transport/sync/sync-types';
import type { TickTimer } from '../../../../src/audio/transport/tick-timer';

/**
 * midi-clock-sync.md v8 end to end: two real Clocks on one simulated time base,
 * a real SyncMaster and a real SyncSlave, and a wire between them that behaves
 * like the real one. Nothing else in the suite joins the two halves, which is
 * how a master's loop wrap left slaves a 16th off, and a hardware master left
 * them two pulses late, with every unit test green.
 *
 * Two wires, one per transport's delivery semantics:
 *  - MIDI: a message is delivered at its scheduled time (Web MIDI's
 *    `send(data, timestamp)`), in timestamp order, `latencyMs` later.
 *  - WiFi: a message goes out at once; a pulse carries its stamp, and a join its
 *    `at` (webrtc-sync.md REQ-a-join-carries-its-time) — both already in the
 *    receiver's domain, since the two share a time base here.
 */
type Wire = 'midi' | 'wifi';

function rig(wire: Wire, latencyMs = 1) {
  let t = 0;
  const ctx = { get currentTime() { return t; } } as unknown as AudioContext;
  const wakeups = new Set<() => void>();
  const timer = (): TickTimer => {
    let cb: (() => void) | null = null;
    return {
      start(fn) { if (cb) wakeups.delete(cb); cb = fn; wakeups.add(fn); },
      stop() { if (cb) wakeups.delete(cb); cb = null; },
    };
  };
  const masterClock = new Clock(ctx, { timer: timer() });
  const slaveClock = new Clock(ctx, { timer: timer() });
  const queue: { deliverAt: number; seq: number; msg: SyncMessage; stamp: number }[] = [];
  let seq = 0;
  const send = (msg: SyncMessage, atMs?: number): void => {
    const nowMs = t * 1000;
    if (wire === 'midi') {
      const at = atMs ?? nowMs;
      queue.push({ deliverAt: at + latencyMs, seq: seq++, msg, stamp: at + latencyMs });
    } else if (msg.type === 'pulse') {
      queue.push({ deliverAt: nowMs + latencyMs, seq: seq++, msg, stamp: atMs ?? nowMs });
    } else if ((msg.type === 'start' || msg.type === 'continue') && atMs !== undefined) {
      queue.push({ deliverAt: nowMs + latencyMs, seq: seq++, msg: { type: msg.type, at: atMs }, stamp: nowMs + latencyMs });
    } else {
      queue.push({ deliverAt: nowMs + latencyMs, seq: seq++, msg, stamp: nowMs + latencyMs });
    }
  };
  const master = new SyncMaster(masterClock, send, (s) => s * 1000, { timer: timer(), nowMs: () => t * 1000 });
  const slave = new SyncSlave(slaveClock, { localBpm: () => 120, toAudioTime: (ms) => ms / 1000 });
  slave.enable();
  master.enable();
  // SyncController's job in the app: every jump is announced (REQ-a-midi-master-announces-its-seek).
  masterClock.onSeek(() => master.announceTo(send));

  const masterTicks: [number, number][] = [];
  const slaveTicks: [number, number][] = [];
  masterClock.onTick((s, w) => masterTicks.push([s, w]));
  slaveClock.onTick((s, w) => slaveTicks.push([s, w]));

  const run = (seconds: number): void => {
    const end = t + seconds;
    while (t < end) {
      t += 0.002;
      queue.sort((a, b) => a.deliverAt - b.deliverAt || a.seq - b.seq);
      while (queue.length && queue[0]!.deliverAt <= t * 1000) {
        const q = queue.shift()!;
        slave.handleMessage(q.msg, q.stamp);
      }
      for (const cb of [...wakeups]) cb();
    }
  };

  /** For each master 8th note in [from, to): the slave step sounding nearest it, and how far off. */
  const compare = (from: number, to: number) =>
    masterTicks
      .filter(([s, w]) => w >= from && w < to && s % 2 === 0)
      .map(([s, w]) => {
        let best = slaveTicks[0]!;
        for (const st of slaveTicks) if (Math.abs(st[1] - w) < Math.abs(best[1] - w)) best = st;
        return { master: s % 16, slave: best[0] % 16, offsetMs: (best[1] - w) * 1000 };
      });

  return { masterClock, run, compare, send, handle: (m: SyncMessage, at: number) => slave.handleMessage(m, at), slaveTicks, now: () => t };
}

/** Loop bar 2 (steps 16..31) from the first time the master reaches bar 3. */
const loopBarTwo = (next: number): number => (next % 16 === 0 && next >= 32 ? 16 : next);

describe('sync loopback (midi-clock-sync.md v8)', () => {
  for (const wire of ['midi', 'wifi'] as const) {
    describe(`over ${wire === 'midi' ? 'MIDI' : 'WiFi'} timing`, () => {
      it('starts in step with the master', () => {
        const r = rig(wire);
        r.masterClock.start(0);
        r.run(3);
        const rows = r.compare(1, 3);
        expect(rows.length).toBeGreaterThanOrEqual(8);
        for (const row of rows) {
          expect(row.slave).toBe(row.master);
          expect(Math.abs(row.offsetMs)).toBeLessThan(5);
        }
      });

      it('stays in step through repeated loop wraps (REQ-a-following-slave-jumps-in-place, regression)', () => {
        const r = rig(wire);
        r.masterClock.start(0);
        r.run(3);
        r.masterClock.setStepRouter(loopBarTwo);
        r.run(12); // six wraps of a two-second bar
        // The bug: after a few wraps the slave sat one 16th ahead for good
        // (master step 8 against slave step 9, all round the bar).
        const rows = r.compare(11, 15);
        expect(rows.length).toBeGreaterThanOrEqual(8);
        for (const row of rows) {
          expect(row.slave).toBe(row.master);
          expect(Math.abs(row.offsetMs)).toBeLessThan(5);
        }
      });
    });
  }

  it('starts a slave on a hardware master\'s first pulse (REQ-a-join-is-timed-by-its-first-pulse, regression)', () => {
    // A hardware master sends Start and then clock straight away. The slave
    // used to put step 0 at arrival + 50 ms, and the re-anchor then locked in
    // 41.7 ms (two pulses) of that for good.
    const r = rig('midi');
    const pulseMs = 60000 / 120 / 24;
    const T0 = 1000;
    let next = T0;
    let started = false;
    const drive = (untilMs: number) => {
      while (r.now() * 1000 < untilMs) {
        const nowMs = r.now() * 1000;
        if (!started && nowMs >= T0) { r.handle({ type: 'start' }, nowMs); started = true; }
        while (started && next <= nowMs) { r.handle({ type: 'pulse' }, next); next += pulseMs; }
        r.run(0.001);
      }
    };
    drive(7000);
    for (const k of [0, 8, 16, 32, 48]) {
      const want = (T0 + k * 6 * pulseMs) / 1000;
      const got = r.slaveTicks.find(([s]) => s === k);
      expect(got, `step ${k}`).toBeDefined();
      expect(Math.abs(got![1] - want) * 1000, `step ${k}`).toBeLessThan(3);
    }
  });
});
