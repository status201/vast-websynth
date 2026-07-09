import { describe, it, expect, vi, afterEach } from 'vitest';
import { Clock } from '../../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../../src/audio/transport/tick-timer';
import { SyncMaster } from '../../../../src/audio/transport/sync/sync-master';
import type { SyncMessage } from '../../../../src/audio/transport/sync/sync-types';

/**
 * Same two-fake-clocks setup as clock.test.ts: a mutable `currentTime` plus
 * Vitest fake timers. `toPerfMs` maps AudioContext seconds to a synthetic
 * perf-ms domain 1:1000 so pulse timestamps are directly assertable.
 */
function setup(swing = 0) {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 } as unknown as AudioContext;
  const clock = new Clock(ctx, { timer: new TimeoutTimer() });
  clock.setBpm(120); // one 16th = 0.125 s; one pulse = 125/6 ms
  clock.setSwing(swing);
  const sent: Array<{ msg: SyncMessage; atMs: number | undefined }> = [];
  const master = new SyncMaster(clock, (msg, atMs) => sent.push({ msg, atMs }), (t) => t * 1000);
  const advance = (audioS: number) => {
    (ctx as unknown as { currentTime: number }).currentTime += audioS;
    vi.advanceTimersByTime(25);
  };
  return { clock, master, sent, advance };
}

afterEach(() => {
  vi.useRealTimers();
});

const pulses = (sent: Array<{ msg: SyncMessage; atMs: number | undefined }>) =>
  sent.filter((s) => s.msg.type === 'pulse');

describe('SyncMaster', () => {
  it('emits start then 24-PPQN pulses spaced 60000/(bpm*24) ms apart', () => {
    const { clock, master, sent, advance } = setup();
    master.enable();
    clock.start(); // step 0 drains synchronously
    expect(sent[0]!.msg.type).toBe('start');

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

  it('broadcasts stop on any clock stop', () => {
    const { clock, master, sent } = setup();
    master.enable();
    clock.start();
    clock.stop();
    expect(sent[sent.length - 1]!.msg.type).toBe('stop');
  });

  it('enabling mid-play sends start now (slaves join at bar 0)', () => {
    const { clock, master, sent } = setup();
    clock.start();
    expect(sent.length).toBe(0); // not yet enabled
    master.enable();
    expect(sent[0]!.msg.type).toBe('start');
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
