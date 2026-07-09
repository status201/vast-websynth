import { describe, it, expect, vi, afterEach } from 'vitest';
import { Clock } from '../../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../../src/audio/transport/tick-timer';
import { SyncSlave } from '../../../../src/audio/transport/sync/sync-slave';

/**
 * The slave runs against a real Clock on a fake AudioContext (clock.test.ts
 * pattern). Synthetic pulse timestamps are perf-domain ms; `toAudioTime` maps
 * them 1000:1 into AudioContext seconds so both clocks agree.
 */
function setup(localBpm = 120) {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 } as unknown as AudioContext;
  const clock = new Clock(ctx, { timer: new TimeoutTimer() });
  clock.setBpm(localBpm);
  const slave = new SyncSlave(clock, {
    localBpm: () => localBpm,
    toAudioTime: (ms) => ms / 1000,
  });
  slave.enable();
  const advance = (audioS: number) => {
    (ctx as unknown as { currentTime: number }).currentTime += audioS;
    vi.advanceTimersByTime(25);
  };
  return { clock, slave, advance };
}

afterEach(() => {
  vi.useRealTimers();
});

const intervalMs = (bpm: number): number => 60000 / (bpm * 24);
const clockBpm = (clock: Clock): number => 15 / clock.sixteenthDuration();
const jitter = (i: number): number => [3, -3, 1.5, -1.5, 0][i % 5]!;

describe('SyncSlave', () => {
  it('start begins playback; stop ends it', () => {
    const { clock, slave } = setup();
    slave.handleMessage({ type: 'start' }, 0);
    expect(clock.playing).toBe(true);
    slave.handleMessage({ type: 'stop' }, 100);
    expect(clock.playing).toBe(false);
  });

  it('converges to the master tempo within two beats of steady pulses', () => {
    const { clock, slave } = setup();
    slave.handleMessage({ type: 'start' }, 0);
    const dt = intervalMs(140);
    for (let i = 0; i < 48; i++) slave.handleMessage({ type: 'pulse' }, i * dt); // 2 beats
    expect(Math.abs(clockBpm(clock) - 140)).toBeLessThan(0.5);
    expect(slave.followedBpm!).toBeCloseTo(140, 0);
  });

  it('throttles BPM writes and keeps them within ±1 under ±3 ms jitter', () => {
    const { clock, slave } = setup();
    const setBpm = vi.spyOn(clock, 'setBpm');
    slave.handleMessage({ type: 'start' }, 0);
    const dt = intervalMs(120);
    const total = Math.ceil(2000 / dt); // two seconds of pulses
    for (let i = 0; i < total; i++) slave.handleMessage({ type: 'pulse' }, i * dt + jitter(i));
    expect(setBpm.mock.calls.length).toBeLessThanOrEqual(8); // >= 250 ms apart
    for (const [v] of setBpm.mock.calls) expect(Math.abs((v as number) - 120)).toBeLessThan(1);
  });

  it('a start while already playing restarts from step 0 (bar realign)', () => {
    const { clock, slave, advance } = setup();
    const steps: number[] = [];
    clock.onTick((step) => steps.push(step));
    slave.handleMessage({ type: 'start' }, 0);
    advance(0.25); // move a few steps in
    expect(steps[steps.length - 1]!).toBeGreaterThan(0);
    slave.handleMessage({ type: 'start' }, 300);
    expect(clock.playing).toBe(true);
    expect(steps[steps.length - 1]!).toBe(0); // restarted grid
  });

  it('keeps playing at the last tempo through a pulse stall, and reports it', () => {
    const { clock, slave, advance } = setup();
    slave.handleMessage({ type: 'start' }, 0);
    const dt = intervalMs(120);
    for (let i = 0; i < 30; i++) slave.handleMessage({ type: 'pulse' }, i * dt);
    expect(slave.stalled).toBe(false);
    advance(2.0); // ticks flow, pulses don't — > 1 s of silence
    expect(slave.stalled).toBe(true);
    expect(clock.playing).toBe(true); // free-running, not dead
    slave.handleMessage({ type: 'stop' }, 5000); // a stop still lands
    expect(clock.playing).toBe(false);
    expect(slave.stalled).toBe(false);
  });

  it('warms its estimate from pulses that arrive while stopped', () => {
    const { clock, slave } = setup();
    const dt = intervalMs(150);
    for (let i = 0; i < 30; i++) slave.handleMessage({ type: 'pulse' }, i * dt);
    expect(clock.playing).toBe(false); // pulses alone never start the transport
    expect(slave.followedBpm!).toBeCloseTo(150, 0);
  });

  it('disable restores the local (knob) tempo', () => {
    const { clock, slave } = setup(100);
    slave.handleMessage({ type: 'start' }, 0);
    const dt = intervalMs(140);
    for (let i = 0; i < 48; i++) slave.handleMessage({ type: 'pulse' }, i * dt);
    expect(Math.abs(clockBpm(clock) - 140)).toBeLessThan(0.5);
    slave.disable();
    expect(clockBpm(clock)).toBeCloseTo(100, 6);
  });
});
