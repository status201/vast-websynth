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

  it('is inert off iOS: no element, no playback', () => {
    asDesktop();
    const session = new IosAudioSession();
    expect(session.active).toBe(false);
    session.unlock();
    session.rearm();
    expect(playSpy).not.toHaveBeenCalled();
    expect((session as unknown as { el: unknown }).el).toBeNull();
  });

  it('on iOS, unlock() builds and plays a silent looping element', () => {
    asIOS();
    const session = new IosAudioSession();
    expect(session.active).toBe(true);
    session.unlock();
    expect(playSpy).toHaveBeenCalledTimes(1);
    const el = playSpy.mock.instances[0] as HTMLAudioElement;
    expect(el.loop).toBe(true);
    expect(el.getAttribute('playsinline')).toBe('');
  });

  it('on iOS, the element is built once and reused by unlock/rearm', () => {
    asIOS();
    const session = new IosAudioSession();
    session.unlock();
    session.rearm();
    expect(playSpy).toHaveBeenCalledTimes(2);
    // Same element instance both times (built lazily, reused).
    expect(playSpy.mock.instances[0]).toBe(playSpy.mock.instances[1]);
  });

  it('rearm() before any unlock is a no-op even on iOS', () => {
    asIOS();
    const session = new IosAudioSession();
    session.rearm();
    expect(playSpy).not.toHaveBeenCalled();
  });
});
