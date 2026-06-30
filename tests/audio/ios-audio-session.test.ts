import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IosAudioSession, shouldResumeContext } from '../../src/audio/ios-audio-session';

/** `IosAudioSession.active` is `isIOS()` evaluated at construction, so stub the
 *  navigator BEFORE `new IosAudioSession()`. */
function asIOS(): void {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', platform: 'iPhone', maxTouchPoints: 5 });
}
function asDesktop(): void {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 0 });
}

/** Minimal AudioContext stub: only `createMediaElementSource` + `destination` are used. */
function fakeCtx() {
  const connect = vi.fn();
  const destination = { id: 'destination' };
  const createMediaElementSource = vi.fn(() => ({ connect }));
  const ctx = { createMediaElementSource, destination } as unknown as AudioContext;
  return { ctx, createMediaElementSource, connect, destination };
}

/** Let queued microtasks (the play().then chain) settle. */
const flush = () => new Promise((r) => setTimeout(r));

describe('shouldResumeContext', () => {
  it('is true for suspended and the iOS-only interrupted state', () => {
    expect(shouldResumeContext('suspended')).toBe(true);
    expect(shouldResumeContext('interrupted')).toBe(true);
  });
  it('is false for running and closed', () => {
    expect(shouldResumeContext('running')).toBe(false);
    expect(shouldResumeContext('closed')).toBe(false);
  });
});

describe('IosAudioSession', () => {
  let playSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:fake');
    // jsdom does not implement HTMLMediaElement.play — stub it to a resolved promise.
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is inert off iOS: no element, no source, no playback', () => {
    asDesktop();
    const { ctx, createMediaElementSource } = fakeCtx();
    const session = new IosAudioSession(ctx);
    session.unlock();
    session.rearm();
    expect(playSpy).not.toHaveBeenCalled();
    expect(createMediaElementSource).not.toHaveBeenCalled();
    expect((session as unknown as { el: unknown }).el).toBeNull();
    expect(session.diagnostics).toMatchObject({ active: false, status: 'n/a', routed: false, paused: null });
  });

  it('on iOS, unlock() builds a looping element routed through the context and plays it', async () => {
    asIOS();
    const { ctx, createMediaElementSource, connect, destination } = fakeCtx();
    const session = new IosAudioSession(ctx);
    session.unlock();

    expect(playSpy).toHaveBeenCalledTimes(1);
    const el = playSpy.mock.instances[0] as HTMLAudioElement;
    expect(el.loop).toBe(true);
    expect(el.getAttribute('playsinline')).toBe('');
    expect(createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(destination);
    expect(session.diagnostics).toMatchObject({ active: true, routed: true });

    await flush();
    expect(session.diagnostics.status).toBe('playing');
  });

  it('on iOS, a rejected play() is recorded as a blocked status', async () => {
    asIOS();
    playSpy.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    const { ctx } = fakeCtx();
    const session = new IosAudioSession(ctx);
    session.unlock();
    await flush();
    expect(session.diagnostics.status).toBe('blocked: NotAllowedError');
  });

  it('on iOS, the element and source are built once and reused by unlock/rearm', () => {
    asIOS();
    const { ctx, createMediaElementSource } = fakeCtx();
    const session = new IosAudioSession(ctx);
    session.unlock();
    session.rearm();
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(playSpy.mock.instances[0]).toBe(playSpy.mock.instances[1]);
  });

  it('rearm() before any unlock is a no-op even on iOS', () => {
    asIOS();
    const { ctx } = fakeCtx();
    const session = new IosAudioSession(ctx);
    session.rearm();
    expect(playSpy).not.toHaveBeenCalled();
  });
});
