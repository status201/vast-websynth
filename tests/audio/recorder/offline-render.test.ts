import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderEffect } from '../../../src/audio/recorder/offline-render';
import type { CapturedAudio } from '../../../src/audio/recorder/node';

/**
 * `renderEffect` — the two edits that need real DSP (filter, octave), rendered
 * through an `OfflineAudioContext` (sample-recorder.md REQ-2). jsdom has no
 * OfflineAudioContext, so this stubs one that records the graph it was asked to
 * build and hands back a buffer of the requested length.
 *
 * What that pins is the part with arithmetic in it and the part a refactor gets
 * wrong: the output length (an octave shift is a resample, so it changes
 * duration as well as pitch), the node wiring per effect kind, and the channel
 * handling. The filter's actual frequency response is the browser's, not ours.
 */

interface BuiltGraph {
  channels: number;
  length: number;
  sampleRate: number;
  playbackRate: number;
  biquad: { type: string; freq: number; q: number } | null;
  /** Nodes connected to the destination, in the order they were connected. */
  connectedToDestination: string[];
  started: boolean;
}

let graphs: BuiltGraph[] = [];
/** Channel count of the buffer the stub renders — 1 exercises the mono fallback. */
let renderChannels = 2;
/** The channel arrays the last render handed out, kept to test aliasing. */
let rendered: Float32Array[] = [];

class FakeOfflineAudioContext {
  private readonly g: BuiltGraph;
  readonly destination = { name: 'destination' };

  constructor(channels: number, length: number, sampleRate: number) {
    this.g = {
      channels, length, sampleRate,
      playbackRate: 1, biquad: null, connectedToDestination: [], started: false,
    };
    graphs.push(this.g);
  }

  private node(name: string, extra: Record<string, unknown> = {}) {
    const self = this;
    return {
      name,
      ...extra,
      connect(target: { name?: string }) {
        if (target?.name === 'destination') self.g.connectedToDestination.push(name);
        return target;
      },
    };
  }

  createBufferSource() {
    const g = this.g;
    return this.node('source', {
      buffer: null as unknown,
      playbackRate: { get value() { return g.playbackRate; }, set value(v: number) { g.playbackRate = v; } },
      start: () => { g.started = true; },
    });
  }

  // Built literally rather than via `node()`: spreading an object with accessors
  // copies their current *values*, so `type` would silently stop recording.
  createBiquadFilter() {
    const g = this.g;
    const rec = { type: '', freq: 0, q: 0 };
    g.biquad = rec;
    return {
      name: 'biquad',
      get type() { return rec.type; },
      set type(v: string) { rec.type = v; },
      frequency: { get value() { return rec.freq; }, set value(v: number) { rec.freq = v; } },
      Q: { get value() { return rec.q; }, set value(v: number) { rec.q = v; } },
      connect: (target: { name?: string }) => {
        if (target?.name === 'destination') g.connectedToDestination.push('biquad');
        return target;
      },
    };
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (c: number) => data[c]! };
  }

  async startRendering() {
    // A ramp, so a test can tell the channels apart and see real samples come
    // back. Retained in `rendered` so a test can prove the result is a *copy*:
    // a real OfflineAudioContext may reuse its channel storage, so handing the
    // caller a view onto it would be a live aliasing bug.
    const data = Array.from({ length: renderChannels }, (_, ch) =>
      Float32Array.from({ length: this.g.length }, (_, i) => (ch + 1) / 10 + i / 1000));
    rendered = data;
    return {
      numberOfChannels: renderChannels,
      length: this.g.length,
      sampleRate: this.g.sampleRate,
      getChannelData: (c: number) => data[c]!,
    };
  }
}

function captured(frames: number, sampleRate = 44100): CapturedAudio {
  return {
    left: Float32Array.from({ length: frames }, (_, i) => i / frames),
    right: Float32Array.from({ length: frames }, (_, i) => -i / frames),
    sampleRate,
  };
}

beforeEach(() => {
  graphs = [];
  renderChannels = 2;
  rendered = [];
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
});

afterEach(() => vi.unstubAllGlobals());

describe('renderEffect — output length', () => {
  it('keeps the length for a filter', async () => {
    const out = await renderEffect(captured(1000), { kind: 'lowpass', freq: 800 });
    expect(out.left).toHaveLength(1000);
    expect(graphs[0]!.length).toBe(1000);
  });

  // An octave is a plain resample: it changes pitch AND duration, which is the
  // cheap/fun behaviour a sampler toy wants, not a formant-preserving shift.
  it('halves the length an octave up and doubles it an octave down', async () => {
    expect((await renderEffect(captured(1000), { kind: 'octaveUp' })).left).toHaveLength(500);
    expect((await renderEffect(captured(1000), { kind: 'octaveDown' })).left).toHaveLength(2000);
  });

  it('rounds an odd length up, so no frame is dropped', async () => {
    expect((await renderEffect(captured(1001), { kind: 'octaveUp' })).left).toHaveLength(501);
  });

  it('renders at least one frame, however short the source', async () => {
    expect((await renderEffect(captured(1), { kind: 'octaveUp' })).left).toHaveLength(1);
  });

  it('takes the shorter channel when the two disagree', async () => {
    const a: CapturedAudio = { left: new Float32Array(800), right: new Float32Array(1000), sampleRate: 44100 };
    expect((await renderEffect(a, { kind: 'lowpass', freq: 800 })).left).toHaveLength(800);
  });
});

describe('renderEffect — the graph it builds', () => {
  it('routes a filter through a biquad of that kind at Q 0.707', async () => {
    await renderEffect(captured(64), { kind: 'highpass', freq: 1200 });
    const g = graphs[0]!;
    expect(g.biquad).toEqual({ type: 'highpass', freq: 1200, q: 0.707 });
    expect(g.connectedToDestination).toEqual(['biquad']); // source → biquad → out
    expect(g.playbackRate).toBe(1);
    expect(g.started).toBe(true);
  });

  it('shifts an octave with playbackRate and no filter at all', async () => {
    await renderEffect(captured(64), { kind: 'octaveUp' });
    expect(graphs[0]!.playbackRate).toBe(2);
    expect(graphs[0]!.biquad).toBeNull();
    expect(graphs[0]!.connectedToDestination).toEqual(['source']); // source → out

    await renderEffect(captured(64), { kind: 'octaveDown' });
    expect(graphs[1]!.playbackRate).toBe(0.5);
  });

  it('renders in stereo at the source sample rate', async () => {
    await renderEffect(captured(64, 48000), { kind: 'lowpass', freq: 500 });
    expect(graphs[0]!.channels).toBe(2);
    expect(graphs[0]!.sampleRate).toBe(48000);
  });
});

describe('renderEffect — what comes back', () => {
  it('carries the rendered samples and keeps the source sample rate', async () => {
    const out = await renderEffect(captured(8, 48000), { kind: 'lowpass', freq: 500 });
    expect(out.sampleRate).toBe(48000);
    expect(out.left[0]).toBeCloseTo(0.1, 6); // channel 0 of the stub's ramp
    expect(out.right[0]).toBeCloseTo(0.2, 6); // channel 1 — the channels are distinct
  });

  it('duplicates channel 0 when the render comes back mono', async () => {
    renderChannels = 1;
    const out = await renderEffect(captured(8), { kind: 'lowpass', freq: 500 });
    expect(Array.from(out.right)).toEqual(Array.from(out.left));
  });

  // The guard that keeps an empty take from reaching `new OfflineAudioContext(…, 0, …)`,
  // which throws — an editor with nothing recorded must not blow up.
  it('short-circuits an empty take without building a graph', async () => {
    const out = await renderEffect(
      { left: new Float32Array(0), right: new Float32Array(0), sampleRate: 44100 },
      { kind: 'octaveUp' },
    );
    expect(out.left).toHaveLength(0);
    expect(out.sampleRate).toBe(44100);
    expect(graphs).toEqual([]);
  });

  it('copies the render out, never a view onto the context storage', async () => {
    const out = await renderEffect(captured(8), { kind: 'lowpass', freq: 500 });
    out.left[0] = 99;
    out.right[0] = -99;
    // Still the rendered ramp: the caller edited its own copy.
    expect(rendered[0]![0]).toBeCloseTo(0.1, 6);
    expect(rendered[1]![0]).toBeCloseTo(0.2, 6);
  });

  it('copies the take out on the empty short-circuit too', async () => {
    const src: CapturedAudio = { left: new Float32Array(4), right: new Float32Array(0), sampleRate: 44100 };
    const out = await renderEffect(src, { kind: 'octaveUp' });
    out.left[0] = 99;
    expect(src.left[0]).toBe(0);
  });
});
