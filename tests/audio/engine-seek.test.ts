import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../src/audio/engine';

/**
 * `Engine.seekTo` / `canSeek` — the single guard every playhead-moving surface
 * goes through (transport-position.md REQ-6/REQ-8, midi-clock-sync.md REQ-23/24).
 *
 * A real `Engine` needs an AudioContext, worklet modules and an async `init()`,
 * none of which these two methods touch: they read `sync` / `recorder` /
 * `bankRender` and call `clock.seek`. So the methods are invoked against a
 * structural stub via `Engine.prototype`, which pins the **production** code
 * rather than a re-implementation of it — the same reason the transport suites
 * run their machines against a mock AudioContext instead of a copy of the math.
 */
function engineLike(over: {
  activeMode?: string;
  recording?: boolean;
  rendering?: boolean;
} = {}) {
  const stub = {
    clock: { seek: vi.fn(), step: 0 },
    sync: {
      activeMode: over.activeMode ?? 'off',
      announcePosition: vi.fn(),
    },
    recorder: { isRecording: () => over.recording ?? false },
    bankRender: { isRendering: () => over.rendering ?? false },
    // Both live on the stub, not just borrowed per call: `seekTo` delegates to
    // `this.canSeek()`, so the guard has to be reachable through `this`.
    seekTo: Engine.prototype.seekTo,
    canSeek: Engine.prototype.canSeek,
  } as unknown as Engine;
  return {
    stub: stub as unknown as {
      clock: { seek: ReturnType<typeof vi.fn> };
      sync: { announcePosition: ReturnType<typeof vi.fn> };
    },
    seekTo: (step: number) => stub.seekTo(step),
    canSeek: () => stub.canSeek(),
  };
}

describe('Engine.seekTo guard', () => {
  it('seeks and reports success in the ordinary case', () => {
    const { stub, seekTo, canSeek } = engineLike();
    expect(canSeek()).toBe(true);
    expect(seekTo(48)).toBe(true);
    expect(stub.clock.seek).toHaveBeenCalledWith(48);
  });

  it('rounds and floors the target (no negative or fractional steps)', () => {
    const { stub, seekTo } = engineLike();
    seekTo(-5);
    expect(stub.clock.seek).toHaveBeenLastCalledWith(0);
    seekTo(12.6);
    expect(stub.clock.seek).toHaveBeenLastCalledWith(13);
  });

  // midi-clock-sync.md REQ-24 — the remote transport owns the playhead.
  it('refuses while slaved, and moves nothing', () => {
    const { stub, seekTo, canSeek } = engineLike({ activeMode: 'slave' });
    expect(canSeek()).toBe(false);
    expect(seekTo(64)).toBe(false);
    expect(stub.clock.seek).not.toHaveBeenCalled();
    expect(stub.sync.announcePosition).not.toHaveBeenCalled();
  });

  // audio-export.md REQ-2 / render-to-sampler.md REQ-6 — both bound their
  // capture by absolute step, so a jump would truncate it silently.
  it('refuses while the song recorder is capturing', () => {
    const { stub, seekTo, canSeek } = engineLike({ recording: true });
    expect(canSeek()).toBe(false);
    expect(seekTo(32)).toBe(false);
    expect(stub.clock.seek).not.toHaveBeenCalled();
  });

  it('refuses while a bank render is in flight', () => {
    const { stub, seekTo, canSeek } = engineLike({ rendering: true });
    expect(canSeek()).toBe(false);
    expect(seekTo(32)).toBe(false);
    expect(stub.clock.seek).not.toHaveBeenCalled();
  });

  // midi-clock-sync.md REQ-23 — an unannounced jump leaves every slave behind
  // by the jump distance for the rest of the session.
  it('announces the new position (a no-op unless mastering)', () => {
    const { stub, seekTo } = engineLike({ activeMode: 'master' });
    seekTo(96);
    expect(stub.sync.announcePosition).toHaveBeenCalledTimes(1);
    // The announce is unconditional here; SyncController.announcePosition is
    // what no-ops in the other roles (pinned in sync-controller.test.ts).
  });

  it('does not announce when the seek was refused', () => {
    const { stub, seekTo } = engineLike({ activeMode: 'master', recording: true });
    expect(seekTo(96)).toBe(false);
    expect(stub.sync.announcePosition).not.toHaveBeenCalled();
  });
});
