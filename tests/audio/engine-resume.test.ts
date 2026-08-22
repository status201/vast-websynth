import { describe, it, expect, vi, afterEach } from 'vitest';
import { Engine } from '../../src/audio/engine';
import { makeParam, type MockAudioParam } from './mock-audio-context';

/**
 * `Engine.resume()` — the click-free start (audio-lifecycle.md REQ-1..REQ-3),
 * the context re-arm policy (REQ-4/REQ-5/REQ-15/REQ-18) and the recovery policy
 * (REQ-13/REQ-14/REQ-16).
 *
 * A real `Engine` needs an AudioContext, worklet modules and an async `init()`,
 * none of which these methods touch: they read `ctx` / `master` / `bus` /
 * `iosSession` / `media` and a handful of own fields. So — exactly as
 * `engine-seek.test.ts` does for the seek guard — they are invoked against a
 * structural stub built on `Engine.prototype`, which pins the **production**
 * code rather than a re-implementation of it. Building it with `Object.create`
 * rather than by listing methods means the whole call graph is the real one:
 * `resume()` really does reach `runResume` → `armGestureResume` → `notifyBlocked`.
 */
interface CtxStub {
  state: string;
  currentTime: number;
  resume: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
}

/** Every stub built by a case, so its armed window listeners can be released. */
const built: Engine[] = [];

afterEach(() => {
  for (const e of built) (e as unknown as { disarmGesture: (() => void) | null }).disarmGesture?.();
  built.length = 0;
  vi.useRealTimers();
});

function engineLike(over: { state?: string; volume?: number; ios?: boolean; playing?: boolean } = {}) {
  const gain: MockAudioParam = makeParam(0.8);
  const ctx: CtxStub = {
    state: over.state ?? 'suspended',
    currentTime: 12.5, // frozen while suspended — the fade must be scheduled here
    resume: vi.fn(() => Promise.resolve()),
    suspend: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn(),
  };
  const iosSession = { active: over.ios ?? false, unlock: vi.fn() };
  const media = { unlock: vi.fn(), rearm: vi.fn() };
  // Field initialisers live in the constructor, which is exactly what this
  // sidesteps — so every own field the methods read is seeded here by hand.
  const engine = Object.assign(Object.create(Engine.prototype) as object, {
    ctx,
    master: { gain },
    bus: { get: vi.fn(() => over.volume ?? 0.8) },
    iosSession,
    media,
    clock: { playing: over.playing ?? false },
    deliberateSuspend: false,
    glitchMuted: false,
    glitchTimer: null,
    resumeAttempts: 0,
    blocked: false,
    everRan: false,
    disarmGesture: null,
    resuming: null,
    blockedListeners: new Set<(b: boolean) => void>(),
  }) as unknown as Engine;
  built.push(engine);
  return {
    ctx,
    gain,
    engine,
    unlock: iosSession.unlock,
    mediaUnlock: media.unlock,
    resume: () => engine.resume(),
  };
}

/** Let the retry ladder (RESUME_VERIFY_MS + RESUME_RETRY_MS) run to its end. */
async function settle(p: Promise<void>): Promise<void> {
  await vi.runAllTimersAsync();
  await p;
}

describe('Engine.resume fade-in (click-free start)', () => {
  it('ramps the master up from silence over the fade', async () => {
    const { ctx, gain, resume } = engineLike({ volume: 0.8 });
    ctx.resume.mockImplementation(() => { ctx.state = 'running'; return Promise.resolve(); });
    await resume();

    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(12.5);
    expect(gain.setValueAtTime).toHaveBeenCalledWith(0, 12.5);
    // Target is the master-volume law (v²), matching the bus subscription.
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.8 * 0.8, 12.5 + 0.15);
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('schedules the ramp BEFORE the resume is awaited (REQ-3)', async () => {
    const order: string[] = [];
    const { gain, ctx, resume } = engineLike();
    gain.setValueAtTime.mockImplementation(() => { order.push('fade'); });
    ctx.resume.mockImplementation(() => {
      order.push('resume');
      ctx.state = 'running';
      return Promise.resolve();
    });
    await resume();
    // currentTime is frozen while suspended, so a ramp laid down first is
    // guaranteed to cover the very first rendered blocks.
    expect(order).toEqual(['fade', 'resume']);
  });

  it('unlocks both platform sessions inside the gesture', async () => {
    const { ctx, unlock, mediaUnlock, resume } = engineLike();
    ctx.resume.mockImplementation(() => { ctx.state = 'running'; return Promise.resolve(); });
    await resume();
    expect(unlock).toHaveBeenCalled();      // iOS session category
    expect(mediaUnlock).toHaveBeenCalled(); // Android Media Session keep-alive
  });

  it('recovers the interrupted state too (iOS), not just suspended', async () => {
    const { ctx, gain, resume } = engineLike({ state: 'interrupted', ios: true });
    ctx.resume.mockImplementation(() => { ctx.state = 'running'; return Promise.resolve(); });
    await resume();
    expect(ctx.resume).toHaveBeenCalled();
    expect(gain.setValueAtTime).toHaveBeenCalledWith(0, 12.5);
  });

  it('leaves a RUNNING context alone — no dip, no second resume (REQ-2)', async () => {
    const { ctx, gain, unlock, resume } = engineLike({ state: 'running' });
    await resume();
    expect(gain.cancelScheduledValues).not.toHaveBeenCalled();
    expect(gain.setValueAtTime).not.toHaveBeenCalled();
    expect(gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(unlock).toHaveBeenCalled(); // the session calls still run
  });

  it('leaves a closed context alone', async () => {
    const { ctx, gain, resume } = engineLike({ state: 'closed' });
    await resume();
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(gain.setValueAtTime).not.toHaveBeenCalled();
  });

  it('does not reject when the browser refuses the resume', async () => {
    vi.useFakeTimers();
    const { ctx, resume } = engineLike();
    ctx.resume.mockRejectedValue(new Error('gesture required'));
    await expect(settle(resume())).resolves.toBeUndefined();
  });
});

/**
 * REQ-13/REQ-14 — a resume is verified, not trusted. Fake timers throughout:
 * both the 400 ms verification race and the 150 ms retry gap are real waits.
 */
describe('Engine.resume recovery (REQ-13/REQ-14)', () => {
  it('retries, then arms a gesture fallback when the resume keeps failing', async () => {
    vi.useFakeTimers();
    const { ctx, engine, resume } = engineLike();
    ctx.resume.mockRejectedValue(new Error('gesture required'));
    const seen: boolean[] = [];
    engine.onAudioBlocked((b) => seen.push(b));

    await settle(resume());

    expect(ctx.resume).toHaveBeenCalledTimes(3); // first attempt + RESUME_RETRIES
    expect(engine.audioRecovery).toEqual({ blocked: true, attempts: 1, gestureArmed: true });
    expect(seen).toEqual([true]);
  });

  it('gives up on a resume whose promise never settles, rather than hanging', async () => {
    vi.useFakeTimers();
    const { ctx, engine, resume } = engineLike();
    // Android's refusal is not always a rejection — sometimes it is silence.
    ctx.resume.mockReturnValue(new Promise(() => { /* never settles */ }));

    await settle(resume());

    expect(ctx.resume).toHaveBeenCalledTimes(3);
    expect(engine.audioRecovery.gestureArmed).toBe(true);
  });

  it('brings the audio back on the next tap anywhere, once (REQ-13)', async () => {
    vi.useFakeTimers();
    const { ctx, engine, resume } = engineLike();
    ctx.resume.mockRejectedValue(new Error('gesture required'));
    const seen: boolean[] = [];
    engine.onAudioBlocked((b) => seen.push(b));
    await settle(resume());
    expect(engine.audioRecovery.gestureArmed).toBe(true);

    ctx.resume.mockImplementation(() => { ctx.state = 'running'; return Promise.resolve(); });
    window.dispatchEvent(new Event('pointerdown'));
    await vi.runAllTimersAsync();

    expect(engine.audioRecovery).toEqual({ blocked: false, attempts: 0, gestureArmed: false });
    expect(seen).toEqual([true, false]);

    // One-shot: the sibling listeners went with the one that fired, so a second
    // tap on an already-running context does nothing at all.
    const calls = ctx.resume.mock.calls.length;
    window.dispatchEvent(new Event('pointerdown'));
    await vi.runAllTimersAsync();
    expect(ctx.resume).toHaveBeenCalledTimes(calls);
  });

  it('does not stack a second armed listener while one is waiting', async () => {
    vi.useFakeTimers();
    const { ctx, engine, resume } = engineLike();
    ctx.resume.mockRejectedValue(new Error('gesture required'));
    const seen: boolean[] = [];
    engine.onAudioBlocked((b) => seen.push(b));
    await settle(resume());
    await settle(resume());
    // Two failed runs, but the user is only told once.
    expect(seen).toEqual([true]);
    expect(engine.audioRecovery.attempts).toBe(2);
  });

  it('serialises concurrent resumes into one run', async () => {
    vi.useFakeTimers();
    const { ctx, resume } = engineLike();
    ctx.resume.mockImplementation(() => { ctx.state = 'running'; return Promise.resolve(); });
    const a = resume();
    const b = resume();
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    // A visibilitychange landing mid-retry must join the run in flight, not
    // start a competing one that re-ramps the master under it.
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });
});

/** REQ-16 — the watchdog's fade to zero is undone by whatever brings us back. */
describe('Engine.resume glitch-mute restore (REQ-16)', () => {
  it('restores the master on a context that came back running by itself', async () => {
    const { gain, engine, resume } = engineLike({ state: 'running', volume: 0.8 });
    (engine as unknown as { glitchMuted: boolean }).glitchMuted = true;

    await resume();

    // Not a dip: the gain is at 0, so this ramps 0 → target exactly as a real
    // resume would. Without it the context is running and silent.
    expect(gain.setValueAtTime).toHaveBeenCalledWith(0, 12.5);
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.8 * 0.8, 12.5 + 0.15);
    expect((engine as unknown as { glitchMuted: boolean }).glitchMuted).toBe(false);
  });

  it('still leaves a running context with no outstanding mute completely alone', async () => {
    const { gain, resume } = engineLike({ state: 'running' });
    await resume();
    expect(gain.setValueAtTime).not.toHaveBeenCalled();
  });
});

/**
 * The re-arm listeners (audio-lifecycle.md REQ-4/REQ-5/REQ-15/REQ-18).
 * Registered on the real jsdom `document`/`window`, so each case builds its own
 * stub and asserts on that stub's spy — handlers from earlier cases keep talking
 * to their own.
 */
function rearmLike(over: { state?: string; ios?: boolean; glitchMuted?: boolean; everRan?: boolean } = {}) {
  const ctx = {
    state: over.state ?? 'suspended',
    addEventListener: vi.fn(),
  };
  const resume = vi.fn(() => Promise.resolve());
  const media = { unlock: vi.fn(), rearm: vi.fn() };
  const engine = Object.assign(Object.create(Engine.prototype) as object, {
    ctx,
    resume,
    iosSession: { active: over.ios ?? false },
    media,
    deliberateSuspend: false,
    glitchMuted: over.glitchMuted ?? false,
    glitchTimer: null,
    // The automatic re-arms stay out of the way until audio has run once.
    everRan: over.everRan ?? true,
  }) as unknown as Engine;
  (engine as unknown as { installContextRearm: () => void }).installContextRearm();
  return { ctx, resume, media, engine };
}

const becomeVisible = (): void => {
  document.dispatchEvent(new Event('visibilitychange'));
};

/** The handler `installContextRearm` registered on the context, if any. */
function statechangeHandler(ctx: { addEventListener: ReturnType<typeof vi.fn> }): () => void {
  const call = ctx.addEventListener.mock.calls.find((c) => c[0] === 'statechange');
  expect(call).toBeDefined();
  return call![1] as () => void;
}

describe('Engine context re-arm', () => {
  it('resumes a context the OS suspended while the page was hidden (Android)', () => {
    const { resume } = rearmLike({ state: 'suspended' });
    becomeVisible();
    expect(resume).toHaveBeenCalled();
  });

  it('does nothing on return when the context kept running', () => {
    const { resume } = rearmLike({ state: 'running' });
    becomeVisible();
    expect(resume).not.toHaveBeenCalled();
  });

  it('re-arms the Android keep-alive on the way back too (media-session REQ-6)', () => {
    const { media } = rearmLike({ state: 'running' });
    becomeVisible();
    expect(media.rearm).toHaveBeenCalled();
  });

  it('re-arms unconditionally on iOS, so the silent loop is replayed', () => {
    const { resume } = rearmLike({ state: 'running', ios: true });
    becomeVisible();
    expect(resume).toHaveBeenCalled();
  });

  it('resumes a running-but-muted context so the glitch fade is undone (REQ-16)', () => {
    const { resume } = rearmLike({ state: 'running', glitchMuted: true });
    becomeVisible();
    expect(resume).toHaveBeenCalled();
  });

  it('cancels a watchdog suspend that has not landed yet (REQ-16)', () => {
    const { engine } = rearmLike({ state: 'running' });
    const priv = engine as unknown as { glitchTimer: ReturnType<typeof setTimeout> | null };
    priv.glitchTimer = setTimeout(() => { /* the pending suspend */ }, 1000);
    becomeVisible();
    // Coming back inside the fade window must call the suspend off, or it lands
    // on a page that is already in the foreground.
    expect(priv.glitchTimer).toBeNull();
  });

  it('also re-arms from pageshow, which a bfcache restore fires (REQ-18)', () => {
    const { resume } = rearmLike({ state: 'suspended' });
    window.dispatchEvent(new Event('pageshow'));
    expect(resume).toHaveBeenCalled();
  });

  // REQ-15 — the listener now exists everywhere; what protects the Debug panel's
  // Suspend is the intent flag, not the absence of the listener.
  it('installs a statechange listener on every platform, not just iOS', () => {
    const { ctx } = rearmLike();
    expect(ctx.addEventListener).toHaveBeenCalledWith('statechange', expect.any(Function));
  });

  it('recovers an OS suspend that arrives while the page is visible', () => {
    const { ctx, resume } = rearmLike({ state: 'suspended' });
    statechangeHandler(ctx)();
    expect(resume).toHaveBeenCalled();
  });

  // The initial `pageshow`/`visibilitychange` must not fire a resume over the
  // Tap-to-start modal — a refusal there is expected, not a fault to report.
  it('stays out of the way before audio has ever run', () => {
    const { ctx, resume } = rearmLike({ state: 'suspended', everRan: false });
    becomeVisible();
    window.dispatchEvent(new Event('pageshow'));
    statechangeHandler(ctx)();
    expect(resume).not.toHaveBeenCalled();
  });

  it('leaves a deliberate suspend suspended (REQ-5)', () => {
    const { ctx, resume, engine } = rearmLike({ state: 'suspended' });
    (engine as unknown as { deliberateSuspend: boolean }).deliberateSuspend = true;
    statechangeHandler(ctx)();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('Engine.suspendForDebug (REQ-15)', () => {
  it('marks the suspend deliberate, and any resume clears that', async () => {
    const { ctx, engine } = engineLike({ state: 'running' });
    const priv = engine as unknown as { deliberateSuspend: boolean };

    await engine.suspendForDebug();
    expect(ctx.suspend).toHaveBeenCalled();
    expect(priv.deliberateSuspend).toBe(true);

    await engine.resume();
    expect(priv.deliberateSuspend).toBe(false);
  });

  it('does not reject when the context is already gone', async () => {
    const { ctx, engine } = engineLike({ state: 'running' });
    ctx.suspend.mockRejectedValue(new Error('closed'));
    await expect(engine.suspendForDebug()).resolves.toBeUndefined();
  });
});
