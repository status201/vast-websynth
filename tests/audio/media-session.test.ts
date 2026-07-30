import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MediaSessionKeepAlive } from '../../src/audio/media-session';

/**
 * The Android keep-alive (media-session.md). `active` is `isAndroid()` plus the
 * API check evaluated at construction, so the navigator is stubbed BEFORE
 * `new MediaSessionKeepAlive()` — the same shape as `ios-audio-session.test.ts`.
 */
function fakeMediaSession() {
  const handlers = new Map<string, () => void>();
  return {
    playbackState: 'none' as string,
    metadata: null as unknown,
    setActionHandler: vi.fn((action: string, fn: () => void) => { handlers.set(action, fn); }),
    handlers,
  };
}

function asAndroid(mediaSession: unknown = fakeMediaSession()) {
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8a) Chrome/126',
    mediaSession,
  });
  return mediaSession as ReturnType<typeof fakeMediaSession>;
}
function asDesktop() {
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    mediaSession: fakeMediaSession(),
  });
}

function actions() {
  return { play: vi.fn(), pause: vi.fn(), stop: vi.fn() };
}

/** Let the play().then chain settle. */
const flush = () => new Promise((r) => setTimeout(r));

describe('MediaSessionKeepAlive', () => {
  let playSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:fake');
    // jsdom implements neither play() nor MediaMetadata.
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined as never);
    vi.stubGlobal('MediaMetadata', class { constructor(public init: unknown) {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is inert off Android: no element, no handlers, no metadata', () => {
    asDesktop();
    const ms = (navigator as unknown as { mediaSession: ReturnType<typeof fakeMediaSession> }).mediaSession;
    const keepAlive = new MediaSessionKeepAlive(actions());
    keepAlive.unlock();
    keepAlive.rearm();
    expect(playSpy).not.toHaveBeenCalled();
    expect(ms.setActionHandler).not.toHaveBeenCalled();
    expect(ms.metadata).toBeNull();
    expect(keepAlive.diagnostics).toMatchObject({
      active: false, status: 'n/a', playbackState: 'n/a', handlers: 0, paused: null,
    });
  });

  it('is inert on an Android browser without the API', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 9)' });
    const keepAlive = new MediaSessionKeepAlive(actions());
    keepAlive.unlock();
    expect(keepAlive.diagnostics.active).toBe(false);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('plays a detached silent loop and describes the player (REQ-2/REQ-3)', async () => {
    const ms = asAndroid();
    const keepAlive = new MediaSessionKeepAlive(actions());
    keepAlive.unlock();
    await flush();

    expect(playSpy).toHaveBeenCalled();
    const el = (keepAlive as unknown as { el: HTMLAudioElement }).el;
    expect(el.loop).toBe(true);
    // Detached on purpose: the session must survive a suspended context.
    expect(el.getAttribute('playsinline')).toBe('');
    expect((ms.metadata as { init: { title: string; artwork: unknown[] } }).init.title)
      .toBe('VAST G1-J5');
    expect((ms.metadata as { init: { artwork: unknown[] } }).init.artwork).toHaveLength(2);
    expect(keepAlive.diagnostics).toMatchObject({ active: true, status: 'playing', handlers: 3 });
  });

  it('registers play / pause / stop and drives them (REQ-4)', () => {
    const ms = asAndroid();
    const acts = actions();
    const keepAlive = new MediaSessionKeepAlive(acts);
    keepAlive.unlock();

    expect([...ms.handlers.keys()].sort()).toEqual(['pause', 'play', 'stop']);
    ms.handlers.get('pause')!();
    expect(acts.pause).toHaveBeenCalled();
    expect(ms.playbackState).toBe('paused');
    ms.handlers.get('play')!();
    expect(acts.play).toHaveBeenCalled();
    expect(ms.playbackState).toBe('playing');
    ms.handlers.get('stop')!();
    expect(acts.stop).toHaveBeenCalled();
    expect(ms.playbackState).toBe('paused');
  });

  // REQ-5 — the state describes the AUDIO SESSION, not the transport: an
  // instrument makes sound with the transport stopped, and Android tears down a
  // paused session.
  it('reports playing from unlock, with no transport involved', () => {
    const ms = asAndroid();
    const keepAlive = new MediaSessionKeepAlive(actions());
    keepAlive.unlock();
    expect(ms.playbackState).toBe('playing');
    expect(keepAlive.diagnostics.playbackState).toBe('playing');
  });

  it('builds the element and the handlers once, however often it unlocks', () => {
    const ms = asAndroid();
    const keepAlive = new MediaSessionKeepAlive(actions());
    keepAlive.unlock();
    const el = (keepAlive as unknown as { el: HTMLAudioElement }).el;
    keepAlive.unlock();
    keepAlive.unlock();
    expect((keepAlive as unknown as { el: HTMLAudioElement }).el).toBe(el);
    expect(ms.setActionHandler).toHaveBeenCalledTimes(3);
    expect(keepAlive.diagnostics.handlers).toBe(3);
  });

  it('replays the loop on rearm, and is a no-op before the first unlock', () => {
    asAndroid();
    const keepAlive = new MediaSessionKeepAlive(actions());
    keepAlive.rearm();
    expect(playSpy).not.toHaveBeenCalled();
    keepAlive.unlock();
    keepAlive.rearm();
    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it('survives a browser that refuses playback (edge)', async () => {
    asAndroid();
    playSpy.mockRejectedValue(Object.assign(new Error('nope'), { name: 'NotAllowedError' }));
    const keepAlive = new MediaSessionKeepAlive(actions());
    expect(() => keepAlive.unlock()).not.toThrow();
    await flush();
    expect(keepAlive.diagnostics.status).toBe('blocked: NotAllowedError');
  });

  it('survives a browser that refuses an action handler (edge)', () => {
    const ms = asAndroid();
    ms.setActionHandler.mockImplementation((action: string) => {
      if (action === 'stop') throw new TypeError('unsupported action');
    });
    const keepAlive = new MediaSessionKeepAlive(actions());
    expect(() => keepAlive.unlock()).not.toThrow();
    // The two that took are still wired; only the refused one is missing.
    expect(keepAlive.diagnostics.handlers).toBe(2);
  });

  it('survives a browser with no MediaMetadata (edge)', () => {
    const ms = asAndroid();
    vi.stubGlobal('MediaMetadata', undefined);
    const keepAlive = new MediaSessionKeepAlive(actions());
    expect(() => keepAlive.unlock()).not.toThrow();
    expect(ms.metadata).toBeNull();       // no metadata…
    expect(keepAlive.diagnostics.handlers).toBe(3); // …but the session still forms
  });
});
