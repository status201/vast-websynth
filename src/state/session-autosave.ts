import type { SongFile } from './song';
import type { ParamBus } from './params';
import type { PatternStore } from './patterns';
import type { Arrangement } from '../audio/transport/arrangement';
import type { XyPadStore } from './xy-pad';
import { validateSongFile } from './song-validate';
import { compactSongForExport } from './serialize';

/**
 * Continuous working-session autosave — the "tab close loses nothing" half of
 * the safety net (`specs/features/session-autosave.md`; the load-undo toast in
 * the Song panel is the other half). Debounces a full `Song.capture` of the
 * session into ONE well-known localStorage key, outside the `websynth.song.*`
 * slot namespace so it never appears in `Song.list()`. Boot restores it
 * silently (main.ts) before the UI mounts.
 *
 * The capture callback is injected so this module depends only on the pure
 * validate/serialize helpers, never on `song.ts` itself.
 */

export const SESSION_KEY = 'websynth.session';

const DEFAULT_DEBOUNCE_MS = 1500;

interface SessionPayload {
  v: 1;
  savedAt: number;
  file: unknown;
}

export class SessionAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;

  constructor(
    private readonly capture: () => SongFile,
    opts?: { debounceMs?: number },
  ) {
    this.debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Wire every session-mutating source. Call once at boot, AFTER the silent
   * restore has applied (so the restore itself doesn't schedule a rewrite).
   * Listeners only arm the debounce — capture runs solely in the debounced
   * callback, so a mid-`Song.apply` state can never be captured: the bank
   * listeners `restore()` fires re-arm the timer, and by the time it elapses
   * the apply has long completed and IS the new session.
   */
  attach(deps: { bus: ParamBus; patterns: PatternStore; arr: Arrangement; xy: XyPadStore }): void {
    const touch = (): void => this.touch();
    deps.bus.onChange(touch);
    deps.patterns.onSeqChange(touch);
    deps.patterns.onDrumChange(touch);
    deps.patterns.onSamplerChange(touch);
    deps.patterns.onMotionChange(touch);
    deps.patterns.onSeqBankChange(touch);
    deps.patterns.onDrumBankChange(touch);
    deps.patterns.onSamplerBankChange(touch);
    deps.patterns.onMotionBankChange(touch);
    deps.patterns.onEditBankChange(touch);
    deps.patterns.onSampleMetaChange(touch);
    deps.xy.onChange(touch);

    // Arrangement.onChange also fires every bar boundary while the transport
    // runs (recompute + notify per tick) — gate on a structural fingerprint so
    // playback alone never writes storage.
    let lastArr = arrangementFingerprint(deps.arr);
    deps.arr.onChange(() => {
      const fp = arrangementFingerprint(deps.arr);
      if (fp === lastArr) return;
      lastArr = fp;
      this.touch();
    });

    // A pending save must survive the tab going away. pagehide (not the
    // unreliable-on-mobile beforeunload) plus hidden-visibility for the
    // switched-away-and-killed case.
    window.addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
  }

  /** Arm (or re-arm) the debounced write. */
  touch(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, this.debounceMs);
  }

  /** Write immediately if (and only if) a save is pending. */
  flush(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
  }

  private write(): void {
    try {
      const payload: SessionPayload = {
        v: 1,
        savedAt: Date.now(),
        file: compactSongForExport(this.capture()),
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      // Quota / private mode / storage disabled: autosave silently stands down.
    }
  }

  /**
   * The autosaved session, validated — or null (fresh boot). A corrupt or
   * invalid payload clears the key so it can't wedge every future boot.
   */
  static load(): SongFile | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw) as Partial<SessionPayload>;
      const res = validateSongFile(payload.file);
      if (res.ok) return res.file;
    } catch {
      // fall through to clear
    }
    SessionAutosave.clear();
    return null;
  }

  static clear(): void {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // storage unavailable — nothing to clear
    }
  }
}

/** Structural view of the four chain lanes — playback ticks don't change it. */
function arrangementFingerprint(arr: Arrangement): string {
  return [arr.seq, arr.drum, arr.sampler, arr.motion]
    .map((l) => `${l.enabled ? 1 : 0}:${l.steps.join(',')}`)
    .join('|');
}
