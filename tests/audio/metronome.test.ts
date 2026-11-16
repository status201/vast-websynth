import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMetronome, type Beat } from '../../src/audio/metronome';

/**
 * metronome.md — the beat source and its click, against a stub clock and
 * context. 120 BPM in 4/4: a sixteenth is 0.125 s, a beat 0.5 s, a bar 2 s.
 */

function stubs() {
  const subs = { tick: 0, start: 0, stop: 0 };
  let tick: ((step: number, when: number) => void) | null = null;
  let start: (() => void) | null = null;
  let stop: (() => void) | null = null;
  const clock = {
    playing: false,
    sixteenthDuration: () => 0.125,
    onTick: (fn: (s: number, w: number) => void) => { subs.tick++; tick = fn; return () => { subs.tick--; tick = null; }; },
    onStart: (fn: () => void) => { subs.start++; start = fn; return () => { subs.start--; start = null; }; },
    onStop: (fn: () => void) => { subs.stop++; stop = fn; return () => { subs.stop--; stop = null; }; },
  };
  const clicks: number[] = [];
  const ctx = {
    currentTime: 0,
    destination: {} as AudioNode,
    createOscillator: () => ({
      type: 'sine', frequency: { value: 0 }, onended: null,
      connect: vi.fn(), disconnect: vi.fn(),
      start: (when: number) => { clicks.push(when); },
      stop: vi.fn(),
    }) as unknown as OscillatorNode,
    createGain: () => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(), disconnect: vi.fn(),
    }) as unknown as GainNode,
  };
  const host = { ctx, clock, barTicks: 16, beatTicks: 4 };
  return {
    host, ctx, clock, subs, clicks,
    tick: (s: number, w: number) => tick?.(s, w),
    start: () => { clock.playing = true; start?.(); },
    stop: () => { clock.playing = false; stop?.(); },
  };
}

/** Move audio time forward, letting the 25 ms poll run along the way. */
function advance(s: ReturnType<typeof stubs>, to: number): void {
  while (s.ctx.currentTime < to - 1e-9) {
    s.ctx.currentTime = Math.min(to, s.ctx.currentTime + 0.025);
    vi.advanceTimersByTime(25);
  }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('metronome (metronome.md)', () => {
  it('runs only while held (REQ-a-metronome-runs-only-while-held)', () => {
    const s = stubs();
    const m = createMetronome(s.host);
    const beats: Beat[] = [];
    m.onBeat((b) => beats.push(b));

    // Not held: no subscription, no timer, no beat.
    advance(s, 1);
    expect(s.subs).toEqual({ tick: 0, start: 0, stop: 0 });
    expect(beats).toHaveLength(0);

    const release = m.acquire();
    expect(s.subs).toEqual({ tick: 1, start: 1, stop: 1 });
    advance(s, 2);
    expect(beats.length).toBeGreaterThan(0);

    release();
    release(); // idempotent
    expect(s.subs).toEqual({ tick: 0, start: 0, stop: 0 });
    const n = beats.length;
    advance(s, 4);
    expect(beats).toHaveLength(n);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('follows the transport while playing (REQ-beats-follow-the-transport-while-playing)', () => {
    const s = stubs();
    s.clock.playing = true;
    const m = createMetronome(s.host);
    const beats: Beat[] = [];
    m.onBeat((b) => beats.push(b));
    const release = m.acquire();

    for (let step = 0; step <= 16; step++) s.tick(step, 10 + step * 0.125);
    expect(beats.map((b) => b.when)).toEqual([10, 10.5, 11, 11.5, 12]);
    expect(beats.map((b) => b.downbeat)).toEqual([true, false, false, false, true]);
    expect(beats.map((b) => b.index)).toEqual([0, 1, 2, 3, 0]);
    expect(beats.every((b) => b.playing)).toBe(true);
    release();
  });

  it('runs free at the BPM while stopped (REQ-beats-run-free-while-stopped)', () => {
    const s = stubs();
    const m = createMetronome(s.host);
    const beats: Beat[] = [];
    m.onBeat((b) => beats.push(b));
    const release = m.acquire();
    advance(s, 2.2);

    const whens = beats.map((b) => b.when);
    expect(whens[0]).toBeCloseTo(0.1);
    for (let i = 1; i < whens.length; i++) expect(whens[i]! - whens[i - 1]!).toBeCloseTo(0.5);
    expect(beats.map((b) => b.downbeat).slice(0, 5)).toEqual([true, false, false, false, true]);
    expect(beats.every((b) => !b.playing)).toBe(true);
    release();
  });

  it('continues from the last transport beat when the song stops', () => {
    const s = stubs();
    const m = createMetronome(s.host);
    const beats: Beat[] = [];
    m.onBeat((b) => beats.push(b));
    const release = m.acquire();

    s.start();
    s.ctx.currentTime = 5;
    s.tick(4, 5.0); // beat 2 of the bar, heard at 5.0
    s.stop();
    advance(s, 5.6);
    const free = beats.filter((b) => !b.playing);
    expect(free[0]!.when).toBeCloseTo(5.5);
    expect(free[0]!.index).toBe(2);
    release();
  });

  it('clicks only when asked, and a count-in forces it (REQ-a-count-in-forces-the-click)', () => {
    const s = stubs();
    const m = createMetronome(s.host);
    const release = m.acquire();
    advance(s, 1);
    expect(s.clicks).toHaveLength(0);

    const downbeat = m.countIn();
    expect(downbeat).toBeCloseTo(1 + 0.1 + 2);
    advance(s, downbeat + 0.6);
    // The four counted beats click; the downbeat and after do not.
    expect(s.clicks.map((t) => +t.toFixed(3))).toEqual([1.1, 1.6, 2.1, 2.6]);

    m.setClick(true);
    advance(s, downbeat + 1.6);
    expect(s.clicks.length).toBeGreaterThan(4);
    release();
  });

  it('counts in to the next transport downbeat while playing', () => {
    const s = stubs();
    s.clock.playing = true;
    const m = createMetronome(s.host);
    const release = m.acquire();
    s.ctx.currentTime = 20;
    s.tick(4, 20.0); // beat 2 of bar 1, which began at 19.5
    // The next downbeat (step 16) is at 21.5 — more than a beat away.
    expect(m.countIn()).toBeCloseTo(21.5);
    s.ctx.currentTime = 21.2;
    s.tick(12, 21.0);
    // Now step 16 is only 0.3 s away: the count takes the bar after.
    expect(m.countIn()).toBeCloseTo(23.5);
    release();
  });

  it('a throwing beat listener does not stop the beat', () => {
    const s = stubs();
    const m = createMetronome(s.host);
    const seen: number[] = [];
    m.onBeat(() => { throw new Error('display broke'); });
    m.onBeat((b) => seen.push(b.when));
    const release = m.acquire();
    advance(s, 1.2);
    expect(seen.length).toBeGreaterThan(1);
    release();
  });
});
