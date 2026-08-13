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
  stop: vi.fn(() => ({ left: new Float32Array(4), right: new Float32Array(4), sampleRate: 44100 })),
};

vi.mock('../../../src/audio/recorder/node', () => ({
  RecorderNode: { create: vi.fn(async () => recorderStub) },
}));

/** The mock context plus the two members only mic capture needs. */
function makeCtx() {
  const ctx = makeMockAudioContext() as unknown as Record<string, unknown>;
  ctx.destination = { connect: vi.fn(), disconnect: vi.fn() };
  ctx.createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  return ctx as unknown as AudioContext & { createMediaStreamSource: ReturnType<typeof vi.fn> };
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
