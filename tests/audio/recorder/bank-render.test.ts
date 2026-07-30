import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  bankCropRange,
  BankRenderController,
  RENDER_BARS,
  RENDER_TAIL_MS,
} from '../../../src/audio/recorder/bank-render';
import type { CapturedAudio, RecorderNode } from '../../../src/audio/recorder/node';
import { Clock } from '../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../src/audio/transport/tick-timer';
import { SEQ_LENGTH } from '../../../src/state/patterns';

// ---------- bankCropRange (pure crop math — render-to-sampler REQ-1/2/3) ----------

describe('bankCropRange', () => {
  it('window is exactly one bar and starts at the second bar boundary', () => {
    // 120 BPM @ 44.1 kHz: sixteenth = 0.125 s, bar = 2 s = 88200 samples.
    const r = bankCropRange(0.05, 0.125, 44100, 1000);
    expect(r.end - r.start).toBe(88200);
    // step0 sample (2205) − firstFrame (1000) + one bar (pass 1 skipped).
    expect(r.start).toBe(2205 - 1000 + 88200);
  });

  it('rounds fractional bars to a whole sample count', () => {
    // 133 BPM @ 48 kHz: 16 × (60/133/4) × 48000 = 86616.54… → 86617.
    const sixteenthS = 60 / 133 / 4;
    const r = bankCropRange(0.05, sixteenthS, 48000, 0);
    expect(r.end - r.start).toBe(Math.round(16 * sixteenthS * 48000));
    expect(Number.isInteger(r.start)).toBe(true);
    expect(Number.isInteger(r.end)).toBe(true);
  });

  it('length is independent of where capture began', () => {
    const a = bankCropRange(0.05, 0.125, 48000, 0);
    const b = bankCropRange(0.05, 0.125, 48000, 731);
    expect(a.end - a.start).toBe(b.end - b.start);
    expect(a.start - b.start).toBe(731);
  });
});

// ---------- BankRenderController (transport + capture orchestration) ----------

/** Duck-typed RecorderNode: start/stop/firstFrame, with a scripted capture. */
function fakeNode(opts: { firstFrame: number | null; length: number; sampleRate: number }) {
  const calls: string[] = [];
  const left = new Float32Array(opts.length);
  const right = new Float32Array(opts.length);
  for (let i = 0; i < opts.length; i++) {
    left[i] = i;
    right[i] = -i;
  }
  const node = {
    calls,
    start: () => { calls.push('node.start'); },
    stop: (): CapturedAudio => {
      calls.push('node.stop');
      return { left, right, sampleRate: opts.sampleRate };
    },
    get firstFrame() { return opts.firstFrame; },
  };
  return node as typeof node & RecorderNode;
}

/**
 * Fake-timer harness: both clocks are advanced together in look-ahead-sized
 * wakeups until the controller stops the transport, then the tail timeout
 * fires. step 0 is always emitted at 0.05 (Clock.start's pre-roll).
 *
 * Deliberately not one jump past the window: the drain is bounded, so a grid
 * left far behind `currentTime` reads as a dropout and emits nothing
 * (transport.md REQ-9).
 */
function harness(opts?: {
  firstFrame?: number | null;
  length?: number;
  swing?: number;
  blocked?: () => boolean;
}) {
  vi.useFakeTimers();
  const sampleRate = 8000; // small numbers: 120 BPM bar = 2 s = 16000 samples
  const ctx = { currentTime: 0 } as { currentTime: number };
  const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
  clock.setBpm(120);
  if (opts?.swing) clock.setSwing(opts.swing);
  const node = fakeNode({
    firstFrame: opts?.firstFrame === undefined ? 0 : opts.firstFrame,
    length: opts?.length ?? 40000,
    sampleRate,
  });
  const restore = vi.fn(() => { node.calls.push('restore'); });
  const prepare = vi.fn(() => { node.calls.push('prepare'); return restore; });
  const ctrl = new BankRenderController(clock, node, prepare, opts?.blocked);
  /** Run the transport until the controller stops it (RENDER_BARS bars). */
  const runTransport = (): void => {
    for (let i = 0; i < 4000 && clock.playing; i++) {
      ctx.currentTime += 0.025;
      vi.advanceTimersByTime(25);
    }
  };
  const run = (p: Promise<CapturedAudio>) => {
    runTransport();
    vi.advanceTimersByTime(RENDER_TAIL_MS); // tail → finish
    return p;
  };
  return { ctx, clock, node, prepare, restore, ctrl, run };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BankRenderController', () => {
  it('renders exactly one bar, cropped to the second pass', async () => {
    const { ctrl, run } = harness();
    const out = await run(ctrl.render());
    // 120 BPM @ 8 kHz: bar = 16000 samples; step0 at 0.05 → sample 400.
    expect(out.left.length).toBe(16000);
    expect(out.right.length).toBe(16000);
    const start = 400 + 16000; // step0 sample − firstFrame(0) + bar 1 skipped
    // Mid-buffer samples carry their source index → the crop offset is exact.
    expect(out.left[100]).toBe(start + 100);
    expect(out.right[100]).toBe(-(start + 100));
    // Anti-click fades at both boundaries.
    expect(out.left[0]).toBe(0);
    expect(out.left[out.left.length - 1]).toBe(0);
  });

  it('is swing-blind: same window with heavy swing', async () => {
    const { ctrl, run } = harness({ swing: 0.6 });
    const out = await run(ctrl.render());
    expect(out.left.length).toBe(16000);
    expect(out.left[100]).toBe(400 + 16000 + 100); // step 0 is even → unswung
  });

  it('arms the node before starting the clock, restores after', async () => {
    const { ctrl, run, node, prepare, restore } = harness();
    // node.start must come before the clock emits anything.
    const out = run(ctrl.render());
    expect(node.calls.slice(0, 2)).toEqual(['prepare', 'node.start']);
    await out;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(node.calls.indexOf('restore')).toBeGreaterThan(node.calls.indexOf('node.stop'));
  });

  it('reports state to onState listeners', async () => {
    const { ctrl, run } = harness();
    const states: boolean[] = [];
    ctrl.onState((r) => states.push(r));
    await run(ctrl.render());
    expect(states).toEqual([true, false]);
  });

  it('refuses re-entry while a render is in flight', async () => {
    const { ctrl, run } = harness();
    const first = ctrl.render();
    await expect(ctrl.render()).rejects.toThrow(/already in flight/);
    await run(first); // the in-flight render still completes
  });

  it('refuses while the song recorder is capturing', async () => {
    const { ctrl } = harness({ blocked: () => true });
    await expect(ctrl.render()).rejects.toThrow(/song recorder/);
  });

  it('rejects and still restores when no frames were tagged', async () => {
    const { ctrl, run, restore } = harness({ firstFrame: null });
    await expect(run(ctrl.render())).rejects.toThrow(/captured no audio/);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('rejects when the capture is too short for the bar window', async () => {
    const { ctrl, run, restore } = harness({ length: 20000 }); // < 400 + 2 bars
    await expect(run(ctrl.render())).rejects.toThrow(/missed the bar window/);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('stops after exactly RENDER_BARS bars', async () => {
    const { ctrl, run, clock } = harness();
    const steps: number[] = [];
    clock.onTick((s) => steps.push(s));
    await run(ctrl.render());
    expect(Math.max(...steps)).toBe(RENDER_BARS * SEQ_LENGTH);
    expect(clock.playing).toBe(false); // transport left stopped
  });
});
