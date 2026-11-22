// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openMicSession, MicCaptureError, type MicError } from '../../../src/audio/recorder/mic-capture';
import { makeMockAudioContext } from '../mock-audio-context';

/**
 * `mic-capture.ts` error contract (sample-recorder.md). Every failure branch
 * throws a typed `MicCaptureError` **before** any audio node is built, which is
 * what makes "insecure context is reported, not crashed" true — so each case
 * here also asserts the AudioContext was never touched.
 *
 * `RecorderNode` is mocked for the success path only: it needs a real
 * AudioWorklet, and the module's own behaviour is pinned by the recorder suites.
 */

const recorderStub = {
  input: { connect: vi.fn(), disconnect: vi.fn() },
  start: vi.fn(),
  // Async like the real node: it awaits the worklet's final batch before the
  // take is complete (audio-export.md REQ-chunks-are-batched-then-flushed).
  stop: vi.fn(async () => ({
    left: new Float32Array(4), right: new Float32Array(4), sampleRate: 44100,
  })),
  dispose: vi.fn(),
};

vi.mock('../../../src/audio/recorder/node', () => ({
  RecorderNode: { create: vi.fn(async () => recorderStub) },
}));

/** The mock context plus the two members only mic capture needs. */
function makeCtx() {
  const ctx = makeMockAudioContext() as unknown as Record<string, unknown>;
  ctx.destination = { connect: vi.fn(), disconnect: vi.fn() };
  ctx.createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  // The meter's tap (sample-recorder.md REQ-the-mic-opens-with-the-studio): a
  // window that reads as a steady ±0.5 square, so peak and RMS are both 0.5.
  ctx.createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((a: Float32Array) => {
      for (let i = 0; i < a.length; i++) a[i] = i % 2 ? 0.5 : -0.5;
    }),
  }));
  return ctx as unknown as AudioContext & {
    createMediaStreamSource: ReturnType<typeof vi.fn>;
    createAnalyser: ReturnType<typeof vi.fn>;
  };
}

/** Replace `navigator.mediaDevices` (absent in jsdom, and read-only when present). */
function stubMediaDevices(value: unknown): void {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true, writable: true });
}

function stubSecure(secure: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true, writable: true });
}

/** Run `openMicSession` and return the code it refused with. */
async function codeFor(ctx: AudioContext): Promise<MicError> {
  try {
    await openMicSession(ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(MicCaptureError);
    return (err as MicCaptureError).code;
  }
  throw new Error('openMicSession resolved — expected it to refuse');
}

/** Every `create*` on the mock context, so "no audio was built" is checkable. */
function graphCalls(ctx: AudioContext): number {
  return Object.entries(ctx as unknown as Record<string, { mock?: { calls: unknown[] } }>)
    .filter(([k]) => k.startsWith('create'))
    .reduce((n, [, fn]) => n + (fn.mock?.calls.length ?? 0), 0);
}

beforeEach(() => {
  stubSecure(true);
  vi.clearAllMocks();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(window, 'isSecureContext');
});

describe('openMicSession refusals (sample-recorder.md)', () => {
  it('reports an insecure context instead of throwing a DOM error', async () => {
    stubSecure(false);
    stubMediaDevices({ getUserMedia: vi.fn() });
    const ctx = makeCtx();
    expect(await codeFor(ctx)).toBe('insecure-context');
    // The check comes first, so a plain-HTTP LAN page never even asks.
    expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(graphCalls(ctx)).toBe(0);
  });

  it('reports an unsupported browser when mediaDevices is missing', async () => {
    stubMediaDevices(undefined);
    expect(await codeFor(makeCtx())).toBe('unsupported');
  });

  it('reports an unsupported browser when getUserMedia is missing', async () => {
    stubMediaDevices({});
    expect(await codeFor(makeCtx())).toBe('unsupported');
  });

  it.each(['NotAllowedError', 'SecurityError'])('maps %s to denied', async (name) => {
    stubMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(new DOMException('no', name))) });
    expect(await codeFor(makeCtx())).toBe('denied');
  });

  it.each(['NotFoundError', 'OverconstrainedError', 'NotReadableError'])(
    'maps %s to no-device',
    async (name) => {
      stubMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(new DOMException('no', name))) });
      expect(await codeFor(makeCtx())).toBe('no-device');
    },
  );

  it('maps anything else — including a non-DOMException — to unknown', async () => {
    stubMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(new Error('boom'))) });
    expect(await codeFor(makeCtx())).toBe('unknown');
  });

  it('builds no audio graph on any refusal', async () => {
    stubMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError'))) });
    const ctx = makeCtx();
    await codeFor(ctx);
    expect(graphCalls(ctx)).toBe(0);
    expect(ctx.createMediaStreamSource).not.toHaveBeenCalled();
  });

  it('asks for raw audio — no echo cancellation, noise suppression or AGC', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
    stubMediaDevices({ getUserMedia });
    await codeFor(makeCtx());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
  });
});

describe('a live mic session', () => {
  function fakeStream() {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    return { tracks, stream: { getTracks: () => tracks } as unknown as MediaStream };
  }

  it('monitors silently — the mic reaches the recorder and a muted gain', async () => {
    const { stream } = fakeStream();
    stubMediaDevices({ getUserMedia: vi.fn(async () => stream) });
    const ctx = makeCtx();

    await openMicSession(ctx);

    expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(stream);
    // The recorder is a 0-output sink, so the graph needs a pull toward the
    // destination — at zero gain, or the take would monitor aloud.
    const gain = (ctx.createGain as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(gain.gain.value).toBe(0);
  });

  // The OS mic indicator only clears when every track is stopped.
  it('dispose() stops every track and tears the graph down', async () => {
    const { tracks, stream } = fakeStream();
    stubMediaDevices({ getUserMedia: vi.fn(async () => stream) });
    const ctx = makeCtx();
    const src = { connect: vi.fn(), disconnect: vi.fn() };
    ctx.createMediaStreamSource.mockReturnValue(src);

    const session = await openMicSession(ctx);
    session.dispose();

    for (const t of tracks) expect(t.stop).toHaveBeenCalledTimes(1);
    expect(src.disconnect).toHaveBeenCalled();
    // REQ-the-recorder-node-is-released-with-the-session: the session made this recorder, so the session releases it. Without
    // this, every open of the modal strands a worklet node and its processor.
    expect(recorderStub.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() is idempotent and stops an armed capture first', async () => {
    const { tracks, stream } = fakeStream();
    stubMediaDevices({ getUserMedia: vi.fn(async () => stream) });

    const session = await openMicSession(makeCtx());
    session.start();
    session.dispose();
    session.dispose();

    expect(recorderStub.stop).toHaveBeenCalledTimes(1);
    for (const t of tracks) expect(t.stop).toHaveBeenCalledTimes(1);
    // Cancel, save and re-open all reach dispose; a second pass must be inert.
    expect(recorderStub.dispose).toHaveBeenCalledTimes(1);
  });

  it('level() reads the mic through its analyser, and stops reading once disposed', async () => {
    const { stream } = fakeStream();
    stubMediaDevices({ getUserMedia: vi.fn(async () => stream) });
    const ctx = makeCtx();

    const session = await openMicSession(ctx);
    const lv = session.level();
    expect(lv.peak).toBeCloseTo(0.5);
    expect(lv.rms).toBeCloseTo(0.5);

    session.dispose();
    const analyser = ctx.createAnalyser.mock.results[0]!.value;
    // REQ-the-recorder-node-is-released-with-the-session covers the level tap too.
    expect(analyser.disconnect).toHaveBeenCalled();
    expect(session.level()).toEqual({ peak: 0, rms: 0 });
  });

  it('startedAt is the context time the take was armed at', async () => {
    const { stream } = fakeStream();
    stubMediaDevices({ getUserMedia: vi.fn(async () => stream) });
    const ctx = makeCtx();
    (ctx as unknown as { currentTime: number }).currentTime = 3.25;

    const session = await openMicSession(ctx);
    expect(session.startedAt).toBe(0);
    session.start();
    expect(session.startedAt).toBe(3.25);
  });

  // vocoder.md REQ-the-voice-take-is-cropped-frame-exact: the take's first frame
  // comes from the recorder's frame tag, and the input latency from the track.
  it('firstFrame is the recorder frame tag, and inputLatency() reads the track or 0', async () => {
    const tracks = [{ stop: vi.fn(), getSettings: () => ({ latency: 0.012 }) }];
    const stream = { getTracks: () => tracks, getAudioTracks: () => tracks } as unknown as MediaStream;
    stubMediaDevices({ getUserMedia: vi.fn(async () => stream) });
    (recorderStub as unknown as { firstFrame: number | null }).firstFrame = 12345;

    const session = await openMicSession(makeCtx());
    expect(session.firstFrame).toBe(12345);
    expect(session.inputLatency()).toBeCloseTo(0.012);

    tracks[0]!.getSettings = () => ({ latency: Number.NaN });
    expect(session.inputLatency()).toBe(0);
    tracks[0]!.getSettings = () => ({}) as { latency: number };
    expect(session.inputLatency()).toBe(0);
    (recorderStub as unknown as { firstFrame: number | null }).firstFrame = null;
  });

  it('start() is idempotent while armed, so a double tap records one take', async () => {
    const { stream } = fakeStream();
    stubMediaDevices({ getUserMedia: vi.fn(async () => stream) });

    const session = await openMicSession(makeCtx());
    session.start();
    session.start();
    expect(recorderStub.start).toHaveBeenCalledTimes(1);
  });
});
