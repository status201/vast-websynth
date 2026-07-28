import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  RecorderController, FALLBACK_BARS, MAX_RUNS,
} from '../../../src/audio/recorder/recorder-controller';
import type { CapturedAudio, RecorderNode } from '../../../src/audio/recorder/node';
import { Clock } from '../../../src/audio/transport/clock';
import { TimeoutTimer } from '../../../src/audio/transport/tick-timer';
import { Arrangement } from '../../../src/audio/transport/arrangement';
import { PatternStore, SEQ_LENGTH } from '../../../src/state/patterns';

/**
 * The first direct test of `RecorderController` — v7 turned a single `armed`
 * bool into a four-phase machine with export options, and none of it was pinned.
 * Modelled on the sibling `bank-render.test.ts`: a real `Clock` on fake timers
 * plus a duck-typed node, so the production timing/arithmetic is what runs.
 */

const SAMPLE_RATE = 8000; // 120 BPM bar = 2 s = 16000 frames

/** Duck-typed RecorderNode that counts frames the way the real one does: it
 *  accumulates while "running", and pause/resume gate that without clearing. */
function fakeNode() {
  const calls: string[] = [];
  let running = false;
  let frames = 0;
  const node = {
    calls,
    /** Pretend `n` frames of audio arrived from the worklet. */
    feed(n: number): void { if (running) frames += n; },
    start(): void { calls.push('start'); running = true; frames = 0; },
    pause(): void { calls.push('pause'); running = false; },
    resume(): void { calls.push('resume'); running = true; },
    stop(): CapturedAudio {
      calls.push('stop');
      running = false;
      return {
        left: new Float32Array(frames),
        right: new Float32Array(frames),
        sampleRate: SAMPLE_RATE,
      };
    },
    get capturedFrames(): number { return frames; },
    get sampleRate(): number { return SAMPLE_RATE; },
  };
  return node as typeof node & RecorderNode;
}

function harness() {
  vi.useFakeTimers();
  const ctx = { currentTime: 0 } as { currentTime: number };
  const clock = new Clock(ctx as unknown as AudioContext, { timer: new TimeoutTimer() });
  clock.setBpm(120);
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, clock);
  const node = fakeNode();
  const ctrl = new RecorderController(clock, arrangement, node);
  /** Drain the whole render window in one look-ahead wakeup, then the tail. */
  const drain = (tailMs: number): void => {
    ctx.currentTime = 10_000;
    vi.advanceTimersByTime(25);
    vi.advanceTimersByTime(tailMs);
  };
  /** …and let the `encoding` phase settle back to idle (v7.1 holds it across
   *  the encode+download await, so the finish is no longer synchronous). */
  const finish = async (tailMs: number): Promise<void> => {
    drain(tailMs);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { ctx, clock, arrangement, node, ctrl, drain, finish };
}

let downloads: string[] = [];

beforeEach(() => {
  downloads = [];
  // `triggerDownload` builds an object URL and clicks an <a>; jsdom has neither
  // createObjectURL nor a real download, so stub the two globals it touches.
  const urls = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  Object.assign(URL, urls);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------- Export length (REQ-2) ----------

describe('RecorderController.exportSong', () => {
  it('renders one pass of the longest enabled chain by default', async () => {
    const { ctrl, arrangement, clock, finish, node } = harness();
    arrangement.setDrumChain([0, 1, 2], true); // 3 bars
    ctrl.exportSong('wav');
    expect(ctrl.isExporting()).toBe(true);
    expect(ctrl.phase).toBe('recording');
    node.feed(1000);
    await finish(350);
    // The capture ran from step 0 to exactly 3 × 16, then stopped.
    expect(clock.playing).toBe(false);
    expect(ctrl.phase).toBe('idle');
    expect(ctrl.isExporting()).toBe(false);
  });

  it('falls back to FALLBACK_BARS with no lane enabled (edge)', () => {
    const { ctrl, clock, drain } = harness();
    const steps: number[] = [];
    clock.onTick((s) => steps.push(s));
    ctrl.exportSong('wav');
    drain(350);
    // It stops at the first tick >= stopAtStep, so that step is the last seen.
    expect(steps[steps.length - 1]).toBe(FALLBACK_BARS * SEQ_LENGTH);
  });

  it('multiplies the rendered length by runs (v7, REQ-2)', () => {
    const { ctrl, arrangement, clock, drain } = harness();
    arrangement.setSeqChain([0, 1], true); // 2 bars
    const steps: number[] = [];
    clock.onTick((s) => steps.push(s));
    ctrl.exportSong('wav', { runs: 3 });
    drain(350);
    expect(steps[steps.length - 1]).toBe(2 * 3 * SEQ_LENGTH);
  });

  it('clamps runs to 1..MAX_RUNS', () => {
    for (const [given, expected] of [[0, 1], [-5, 1], [99, MAX_RUNS], [2.4, 2]] as const) {
      const { ctrl, arrangement, clock, drain } = harness();
      arrangement.setSeqChain([0], true); // 1 bar
      const steps: number[] = [];
      clock.onTick((s) => steps.push(s));
      ctrl.exportSong('wav', { runs: given });
      drain(350);
      expect(steps[steps.length - 1]).toBe(expected * SEQ_LENGTH);
      vi.useRealTimers();
    }
  });
});

// ---------- The tail (REQ-3) ----------

describe('the export tail', () => {
  it('waits TAIL_MS by default — bar-exact, as the audio bench needs', () => {
    const { ctrl, ctx, node, drain } = harness();
    ctrl.exportSong('wav'); // no opts: the scripts/audio-bench.mjs call shape
    ctx.currentTime = 10_000;
    vi.advanceTimersByTime(25);   // drain the window; the clock stops
    expect(node.calls).not.toContain('stop'); // still capturing the tail
    vi.advanceTimersByTime(349);
    expect(node.calls).not.toContain('stop');
    vi.advanceTimersByTime(1);
    expect(node.calls).toContain('stop');
  });

  it('waits one whole bar when tailBar is set (v7)', () => {
    const { ctrl, ctx, node, drain } = harness();
    ctrl.exportSong('wav', { tailBar: true });
    ctx.currentTime = 10_000;
    vi.advanceTimersByTime(25);
    // 120 BPM: one bar = 16 × 0.125 s = 2000 ms, not 350.
    vi.advanceTimersByTime(1999);
    expect(node.calls).not.toContain('stop');
    vi.advanceTimersByTime(1);
    expect(node.calls).toContain('stop');
    void drain;
  });

  it('scales the tail bar with the tempo', () => {
    const { ctrl, clock, ctx, node } = harness();
    clock.setBpm(60); // one bar = 4 s
    ctrl.exportSong('wav', { tailBar: true });
    ctx.currentTime = 10_000;
    vi.advanceTimersByTime(25);
    vi.advanceTimersByTime(3999);
    expect(node.calls).not.toContain('stop');
    vi.advanceTimersByTime(1);
    expect(node.calls).toContain('stop');
  });
});

// ---------- Manual phases (REQ-4) ----------

describe('the manual phase machine', () => {
  it('walks idle → recording → paused → recording → review', () => {
    const { ctrl, node } = harness();
    const seen: string[] = [];
    ctrl.onPhase((p) => seen.push(p));

    expect(ctrl.phase).toBe('idle');
    ctrl.startManual();
    expect(ctrl.phase).toBe('recording');
    ctrl.pauseManual();
    expect(ctrl.phase).toBe('paused');
    ctrl.resumeManual();
    expect(ctrl.phase).toBe('recording');
    ctrl.stopManual();
    expect(ctrl.phase).toBe('review');

    expect(seen).toEqual(['recording', 'paused', 'recording', 'review']);
    expect(node.calls).toEqual(['start', 'pause', 'resume', 'stop']);
  });

  it('starts the transport if it is stopped, and leaves it running on stop', () => {
    const { ctrl, clock } = harness();
    expect(clock.playing).toBe(false);
    ctrl.startManual();
    expect(clock.playing).toBe(true);
    ctrl.stopManual();
    expect(clock.playing).toBe(true); // audio-export.md REQ-4
  });

  // The v6 bug this replaces: stopping downloaded unconditionally, so a fluffed
  // take was on disk before you could refuse it.
  it('stopping writes NOTHING — save and discard are the only writers', async () => {
    const { ctrl, node } = harness();
    ctrl.startManual();
    node.feed(4000);
    ctrl.stopManual();
    await Promise.resolve(); // flush microtasks; the transport is still running
    expect(downloads).toEqual([]);

    await ctrl.saveTake('wav');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^websynth-.*\.wav$/);
    expect(ctrl.phase).toBe('idle');
  });

  it('discard drops the take and writes nothing', async () => {
    const { ctrl, node } = harness();
    ctrl.startManual();
    node.feed(4000);
    ctrl.stopManual();
    ctrl.discardTake();
    expect(ctrl.phase).toBe('idle');
    await Promise.resolve();
    expect(downloads).toEqual([]);
    // …and there is no take left to report a length for. The node's frame
    // counter still holds the old count (only start() clears it), so reading
    // straight through left the Record window sitting on a stale 1:34.
    expect(ctrl.capturedSeconds()).toBe(0);
  });

  it('reports 0 once a saved take is written, too (REQ-4 regression)', async () => {
    const { ctrl, node } = harness();
    ctrl.startManual();
    node.feed(8 * SAMPLE_RATE);
    ctrl.stopManual();
    expect(ctrl.capturedSeconds()).toBe(8);
    await ctrl.saveTake('wav');
    expect(ctrl.phase).toBe('idle');
    expect(ctrl.capturedSeconds()).toBe(0);
  });

  it('discarding mid-capture stops the worklet first', () => {
    const { ctrl, node } = harness();
    ctrl.startManual();
    ctrl.discardTake();
    expect(node.calls).toEqual(['start', 'stop']);
    expect(ctrl.phase).toBe('idle');
  });

  // REQ-4: pause splices. The paused stretch never enters the buffer, so the
  // take is one continuous file and the timer never advances during it.
  it('splices out the paused stretch rather than padding it', () => {
    const { ctrl, node } = harness();
    ctrl.startManual();
    node.feed(2 * SAMPLE_RATE);          // 2 s
    expect(ctrl.capturedSeconds()).toBe(2);

    ctrl.pauseManual();
    node.feed(5 * SAMPLE_RATE);          // ignored — the worklet is not running
    expect(ctrl.capturedSeconds()).toBe(2);

    ctrl.resumeManual();
    node.feed(2 * SAMPLE_RATE);
    ctrl.stopManual();
    // 4 s of audio, not 9 — and it is ONE buffer, never two files.
    expect(ctrl.capturedSeconds()).toBe(4);
  });
});

// ---------- Progress, cancel and the encoding phase (v7.1, REQ-10) ----------

describe('the in-flight export', () => {
  it('reports progress through the pass', () => {
    const { ctrl, arrangement, clock, ctx, drain } = harness();
    arrangement.setSeqChain([0, 1], true); // 2 bars = 32 steps
    expect(ctrl.exportProgress()).toBe(0); // nothing running

    ctrl.exportSong('wav');
    ctx.currentTime = 1; // drain ~8 steps of the look-ahead
    vi.advanceTimersByTime(25);
    const mid = ctrl.exportProgress();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    drain(350);
    expect(ctrl.exportProgress()).toBe(0); // finished: not running any more
  });

  it('cancel stops the transport and writes nothing', async () => {
    const { ctrl, clock, node, ctx } = harness();
    ctrl.exportSong('wav');
    ctx.currentTime = 1;
    vi.advanceTimersByTime(25);
    expect(clock.playing).toBe(true);

    ctrl.cancelExport();
    expect(ctrl.phase).toBe('idle');
    expect(ctrl.isExporting()).toBe(false);
    expect(clock.playing).toBe(false);
    expect(node.calls).toEqual(['start', 'stop']);
    await vi.advanceTimersByTimeAsync(5000); // no tail timer survived
    expect(downloads).toEqual([]);
  });

  it('cancelling after the last bar cannot resurrect the download (edge)', async () => {
    const { ctrl, ctx, drain } = harness();
    ctrl.exportSong('wav');
    // Drain past the end so the tail timeout is armed, then cancel inside it.
    ctx.currentTime = 10_000;
    vi.advanceTimersByTime(25);
    ctrl.cancelExport();
    await vi.advanceTimersByTimeAsync(5000);
    expect(downloads).toEqual([]);
    expect(ctrl.phase).toBe('idle');
    void drain;
  });

  it('is a no-op once the render is past capturing', () => {
    const { ctrl } = harness();
    ctrl.cancelExport();                 // nothing running
    expect(ctrl.phase).toBe('idle');
    ctrl.startManual();
    ctrl.cancelExport();                 // a MANUAL take is not an export
    expect(ctrl.phase).toBe('recording');
  });

  // The v7.0 gap: the phase flipped to idle and THEN awaited the encode, so an
  // MP3's seconds in lamejs were reported as "nothing is happening".
  it('holds `encoding` across the encode, for both paths', async () => {
    const { ctrl, node } = harness();
    const seen: string[] = [];
    ctrl.onPhase((p) => seen.push(p));

    ctrl.startManual();
    node.feed(4000);
    ctrl.stopManual();
    const saving = ctrl.saveTake('wav');
    expect(ctrl.phase).toBe('encoding'); // before the await settles
    await saving;
    expect(ctrl.phase).toBe('idle');
    expect(seen).toEqual(['recording', 'review', 'encoding', 'idle']);
  });

  it('keeps isExporting true across the encode, so a second export cannot start', () => {
    const { ctrl, ctx } = harness();
    ctrl.exportSong('wav');
    ctx.currentTime = 10_000;
    vi.advanceTimersByTime(25);
    vi.advanceTimersByTime(350); // tail fires → finishExport → encoding
    expect(ctrl.phase).toBe('encoding');
    expect(ctrl.isExporting()).toBe(true);
    expect(ctrl.isCapturing()).toBe(false); // the node is already stopped
  });
});

// ---------- The two predicates (REQ-2/REQ-4) ----------

describe('the capture predicates', () => {
  it('isCapturing covers recording and paused; isExporting only an export', () => {
    const { ctrl } = harness();
    expect(ctrl.isCapturing()).toBe(false);
    expect(ctrl.isExporting()).toBe(false);

    ctrl.startManual();
    expect(ctrl.isCapturing()).toBe(true);
    expect(ctrl.isExporting()).toBe(false); // a free take never locks the playhead
    ctrl.pauseManual();
    expect(ctrl.isCapturing()).toBe(true);
    ctrl.stopManual();
    expect(ctrl.isCapturing()).toBe(false); // review holds a buffer, not the node
  });

  it('an export sets isExporting for the whole pass, encode included', async () => {
    const { ctrl, finish } = harness();
    ctrl.exportSong('wav');
    expect(ctrl.isExporting()).toBe(true);
    expect(ctrl.isCapturing()).toBe(true);
    await finish(350);
    expect(ctrl.isExporting()).toBe(false);
  });

  it('refuses to export while anything is in flight, including an unsaved take', () => {
    const { ctrl, clock } = harness();
    ctrl.startManual();
    ctrl.stopManual();
    expect(ctrl.phase).toBe('review');
    clock.stop();
    ctrl.exportSong('wav');
    expect(ctrl.isExporting()).toBe(false);
    expect(clock.playing).toBe(false); // it never touched the transport
  });

  it('ignores manual verbs out of phase', () => {
    const { ctrl, node } = harness();
    ctrl.pauseManual();   // nothing is recording
    ctrl.resumeManual();
    ctrl.stopManual();
    expect(ctrl.phase).toBe('idle');
    expect(node.calls).toEqual([]);
  });
});
