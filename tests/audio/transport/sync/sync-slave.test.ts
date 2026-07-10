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

  it('converges to the master tempo within two beats past the post-start settle', () => {
    const { clock, slave } = setup();
    slave.handleMessage({ type: 'start' }, 0);
    // The first ~0.55 s of pulses fall inside the settle window (REQ-16 —
    // they could be a reordered stale tail); convergence is measured from
    // the pulses after it.
    const dt = intervalMs(140);
    for (let i = 0; i < 96; i++) slave.handleMessage({ type: 'pulse' }, i * dt); // settle + 2 beats
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
    // A single 24-interval window reading can be off by up to ±2·jitter/span
    // (±1.44 at ±3 ms); the EMA smooths the readings after the first.
    for (const [v] of setBpm.mock.calls) expect(Math.abs((v as number) - 120)).toBeLessThan(1.5);
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

  it('continue after a song position starts from that beat (mid-song join)', () => {
    const { clock, slave } = setup();
    const steps: number[] = [];
    clock.onTick((step) => steps.push(step));
    slave.handleMessage({ type: 'songposition', beat: 32 }, 0);
    slave.handleMessage({ type: 'continue' }, 0);
    expect(clock.playing).toBe(true);
    expect(steps[0]!).toBe(32); // seeded step, not 0
  });

  it('start ignores a stale pending beat and begins at 0 (v1 behaviour)', () => {
    const { clock, slave } = setup();
    const steps: number[] = [];
    clock.onTick((step) => steps.push(step));
    slave.handleMessage({ type: 'songposition', beat: 32 }, 0);
    slave.handleMessage({ type: 'start' }, 0);
    expect(steps[0]!).toBe(0);
  });

  it('follows an explicit tempo message directly', () => {
    const { clock, slave } = setup(120);
    slave.handleMessage({ type: 'tempo', bpm: 145 }, 0);
    expect(clockBpm(clock)).toBeCloseTo(145, 1);
  });

  it('prefers a fresh tempo message over pulse estimation, then falls back when stale', () => {
    const { clock, slave } = setup(120);
    const setBpm = vi.spyOn(clock, 'setBpm');
    slave.handleMessage({ type: 'tempo', bpm: 100 }, 0); // locks 100
    setBpm.mockClear();

    // Pulses at 140 while the tempo message is still fresh (< 2500 ms) must not
    // rewrite the clock — the explicit tempo wins.
    const dt = intervalMs(140);
    for (let i = 0; i < 48; i++) slave.handleMessage({ type: 'pulse' }, i * dt);
    expect(setBpm).not.toHaveBeenCalled();

    // After the tempo message goes stale (> 2500 ms), pulse estimation resumes.
    setBpm.mockClear();
    const base = 3000;
    for (let i = 0; i < 48; i++) slave.handleMessage({ type: 'pulse' }, base + i * dt);
    expect(setBpm).toHaveBeenCalled();
  });

  it('ignores pulses inside the post-start settle window entirely (REQ-16)', () => {
    const { clock, slave } = setup();
    slave.handleMessage({ type: 'start' }, 0);
    const setBpm = vi.spyOn(clock, 'setBpm');
    // A double-rate contaminated burst, all inside the settle (~550 ms at 120):
    // neither the estimator nor the clock may see it.
    const dt = intervalMs(240);
    for (let i = 0; i < 40; i++) slave.handleMessage({ type: 'pulse' }, i * dt); // ends ~416 ms
    expect(setBpm).not.toHaveBeenCalled();
    expect(slave.followedBpm).toBeNull();
    expect(slave.stalled).toBe(false); // settling pulses still prove the wire is alive
  });

  it('stale in-flight pulses reordered past a start skew neither tempo nor phase (regression)', () => {
    // The MIDI wire hazard: at Start, the untimestamped 0xFA overtakes the
    // future-timestamped idle-pulse tail still queued in MIDIOutput.send, so
    // the slave receives 'start' first, then ~200 ms of the stale idle grid
    // interleaved with the real run pulses. Pre-fix this wrote ~2x tempo (the
    // halved intervals) and skewed the pulse counter so the phase corrector
    // dragged the slave ahead of the master and held it there. The settle
    // window (REQ-16) drops the whole contaminated span by time — per-pulse
    // filtering is not an option, because real MIDI delivery is bursty.
    const { clock, slave, advance } = setup();
    const dt = intervalMs(120);
    // Idle warm-up while stopped: the estimator locks 120 before the start.
    for (let i = -48; i < 0; i++) slave.handleMessage({ type: 'pulse' }, i * dt);
    slave.handleMessage({ type: 'start' }, 0); // local grid: step 0 at +50 ms
    const setBpm = vi.spyOn(clock, 'setBpm');
    const nudge = vi.spyOn(clock, 'nudge');
    // The reordered wire: the stale idle tail (grid continuing from 0) for
    // 200 ms, interleaved with the real run pulses (grid from +50 ms), then
    // the run stream alone — 4 beats of it.
    const events: number[] = [];
    for (let t = dt; t <= 200; t += dt) events.push(t);
    for (let i = 0; i < 96; i++) events.push(50 + i * dt);
    events.sort((a, b) => a - b);
    let cursorMs = 0;
    for (const at of events) {
      while (cursorMs < at) { advance(0.025); cursorMs += 25; } // local ticks flow alongside
      slave.handleMessage({ type: 'pulse' }, at);
    }
    // Tempo never spikes (pre-fix: writes reached ~150+ BPM during the
    // overlap). Post-settle the stream is clean and already at the warmed
    // 120, so any write stays jitter-sized.
    for (const [v] of setBpm.mock.calls) expect(Math.abs((v as number) - 120)).toBeLessThan(2);
    // Phase is not dragged: the skewed counter re-anchors instead of feeding
    // the nudger a permanent "slave is late" error (pre-fix: -10 ms per beat,
    // indefinitely). Allow jitter-scale corrections only.
    const total = nudge.mock.calls.reduce((s, c) => s + (c[0] as number), 0);
    expect(Math.abs(total)).toBeLessThan(0.03);
  });

  it('disable restores the local (knob) tempo', () => {
    const { clock, slave } = setup(100);
    slave.handleMessage({ type: 'start' }, 0);
    const dt = intervalMs(140);
    for (let i = 0; i < 96; i++) slave.handleMessage({ type: 'pulse' }, i * dt); // settle + 2 beats
    expect(Math.abs(clockBpm(clock) - 140)).toBeLessThan(0.5);
    slave.disable();
    expect(clockBpm(clock)).toBeCloseTo(100, 6);
  });
});
