import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../src/audio/engine';
import { makeParam, type MockAudioParam } from './mock-audio-context';

/**
 * `Engine.resume()` — the click-free start (audio-lifecycle.md REQ-1..REQ-3) and
 * the context re-arm policy (REQ-4/REQ-5).
 *
 * A real `Engine` needs an AudioContext, worklet modules and an async `init()`,
 * none of which `resume()` touches: it reads `iosSession` / `ctx` / `master` /
 * `bus`. So — exactly as `engine-seek.test.ts` does for the seek guard — the
 * method is invoked against a structural stub through `Engine.prototype`, which
 * pins the **production** code rather than a re-implementation of it.
 */
function engineLike(over: { state?: string; volume?: number; ios?: boolean } = {}) {
  const gain: MockAudioParam = makeParam(0.8);
  const ctx = {
    state: over.state ?? 'suspended',
    currentTime: 12.5, // frozen while suspended — the fade must be scheduled here
    resume: vi.fn(() => Promise.resolve()),
  };
  const stub = {
    ctx,
    master: { gain },
    bus: { get: vi.fn(() => over.volume ?? 0.8) },
    iosSession: { active: over.ios ?? false, unlock: vi.fn() },
    resume: Engine.prototype.resume,
    // Private on the class; reachable through `this` on the stub.
    fadeInMaster: (Engine.prototype as unknown as { fadeInMaster: () => void }).fadeInMaster,
  } as unknown as Engine;
  return {
    ctx,
    gain,
    unlock: (stub as unknown as { iosSession: { unlock: ReturnType<typeof vi.fn> } }).iosSession.unlock,
    resume: () => stub.resume(),
  };
}

describe('Engine.resume fade-in (click-free start)', () => {
  it('ramps the master up from silence over the fade', async () => {
    const { ctx, gain, resume } = engineLike({ volume: 0.8 });
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
    ctx.resume.mockImplementation(() => { order.push('resume'); return Promise.resolve(); });
    await resume();
    // currentTime is frozen while suspended, so a ramp laid down first is
    // guaranteed to cover the very first rendered blocks.
    expect(order).toEqual(['fade', 'resume']);
  });

  it('unlocks the iOS session first, inside the gesture', async () => {
    const { unlock, resume } = engineLike();
    await resume();
    expect(unlock).toHaveBeenCalled();
  });

  it('recovers the interrupted state too (iOS), not just suspended', async () => {
    const { ctx, gain, resume } = engineLike({ state: 'interrupted', ios: true });
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
    expect(unlock).toHaveBeenCalled(); // the session call still runs
  });

  it('leaves a closed context alone', async () => {
    const { ctx, gain, resume } = engineLike({ state: 'closed' });
    await resume();
    expect(ctx.resume).not.toHaveBeenCalled();
    expect(gain.setValueAtTime).not.toHaveBeenCalled();
  });

  it('does not reject when the browser refuses the resume', async () => {
    const { ctx, resume } = engineLike();
    ctx.resume.mockRejectedValue(new Error('gesture required'));
    await expect(resume()).resolves.toBeUndefined();
  });
});

/**
 * The re-arm listeners (audio-lifecycle.md REQ-4/REQ-5). Registered on the real
 * jsdom `document`, so each case builds its own stub and asserts on that stub's
 * spy — handlers from earlier cases keep talking to their own.
 */
function rearmLike(over: { state?: string; ios?: boolean } = {}) {
  const ctx = {
    state: over.state ?? 'suspended',
    addEventListener: vi.fn(),
  };
  const resume = vi.fn(() => Promise.resolve());
  const stub = {
    ctx,
    resume,
    iosSession: { active: over.ios ?? false },
    installContextRearm: (Engine.prototype as unknown as { installContextRearm: () => void })
      .installContextRearm,
  } as unknown as Engine;
  (stub as unknown as { installContextRearm: () => void }).installContextRearm();
  return { ctx, resume };
}

const becomeVisible = (): void => {
  document.dispatchEvent(new Event('visibilitychange'));
};

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

  // REQ-5 — auto-resuming on statechange off iOS would instantly undo the Debug
  // panel's Suspend action, which acts on a *visible* context.
  it('installs no statechange listener off iOS', () => {
    const { ctx } = rearmLike();
    expect(ctx.addEventListener).not.toHaveBeenCalled();
  });

  it('installs one on iOS, where interrupted arrives while visible', () => {
    const { ctx } = rearmLike({ ios: true });
    expect(ctx.addEventListener).toHaveBeenCalledWith('statechange', expect.any(Function));
  });

  it('re-arms unconditionally on iOS, so the silent loop is replayed', () => {
    const { resume } = rearmLike({ state: 'running', ios: true });
    becomeVisible();
    expect(resume).toHaveBeenCalled();
  });
});
