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

/**
 * The pre-v8 single key. Still READ as a restore candidate so an existing
 * session survives the upgrade; never written again (REQ-12).
 */
export const SESSION_KEY = 'websynth.session';

/** Per-tab session keys: `websynth.session.<tabId>` (REQ-12). */
const SESSION_PREFIX = 'websynth.session.';

/** Where a tab remembers its own id. sessionStorage is per-tab by definition. */
const TAB_ID_KEY = 'websynth.session.tab';

/**
 * How many sessions to keep. Two tabs is the case this exists for; three leaves
 * room without letting closed tabs accumulate. A session is ~50-100 kB (no audio
 * - clips live in IndexedDB), so the cap costs a fraction of the quota.
 */
const MAX_SESSIONS = 3;

const DEFAULT_DEBOUNCE_MS = 1500;

interface SessionPayload {
  v: 1;
  savedAt: number;
  file: unknown;
}

/**
 * This tab's id, minted once and kept in `sessionStorage` - which is scoped to
 * the tab and survives its reload, exactly the lifetime a session wants.
 *
 * With storage unavailable every tab answers `'0'`, which collapses back to one
 * shared key: the old last-writer-wins behaviour, degraded rather than broken
 * (REQ-11's posture).
 */
function tabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_ID_KEY);
    if (existing) return existing;
    const id = Math.random().toString(36).slice(2, 10) || '0';
    sessionStorage.setItem(TAB_ID_KEY, id);
    return id;
  } catch {
    return '0';
  }
}

/** Every stored session key, newest first. Includes the legacy single key. */
function storedSessions(): { key: string; savedAt: number }[] {
  const out: { key: string; savedAt: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key !== SESSION_KEY && !key.startsWith(SESSION_PREFIX)) continue;
      if (key === TAB_ID_KEY) continue;
      const value = localStorage.getItem(key);
      if (value) out.push({ key, savedAt: readSavedAt(value) ?? 0 });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable - nothing to remove
  }
}

export class SessionAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;
  /** This tab's own key - the only one this instance ever writes (REQ-12). */
  private readonly key = SESSION_PREFIX + tabId();

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
    let json: string;
    try {
      const payload: SessionPayload = {
        v: 1,
        savedAt: Date.now(),
        file: compactSongForExport(this.capture()),
      };
      json = JSON.stringify(payload);
    } catch {
      return; // capture/serialize failed - nothing to store
    }
    try {
      localStorage.setItem(this.key, json);
    } catch {
      // Out of room. Keeping other tabs' sessions must never cost us our OWN
      // (REQ-12): drop them and try once more before standing down per REQ-11.
      for (const { key } of storedSessions()) if (key !== this.key) removeKey(key);
      try {
        localStorage.setItem(this.key, json);
      } catch {
        return; // quota / private mode / storage disabled: stand down silently
      }
    }
    this.prune();
  }

  /** Keep at most MAX_SESSIONS, newest first, never dropping our own. */
  private prune(): void {
    const all = storedSessions();
    if (all.length <= MAX_SESSIONS) return;
    for (const { key } of all.slice(MAX_SESSIONS)) {
      if (key !== this.key) removeKey(key);
    }
  }

  /**
   * The autosaved session, validated — or null (fresh boot). A corrupt or
   * invalid payload clears the key so it can't wedge every future boot.
   */
  static load(): SongFile | null {
    // This tab's own session first, so a reload lands exactly where it was; then
    // the most recent of anyone else's, which is what keeps "tab close loses
    // nothing" true once the tab that did the work is gone (REQ-12).
    const own = SESSION_PREFIX + tabId();
    const rest = storedSessions().map((e) => e.key).filter((k) => k !== own);
    for (const key of [own, ...rest]) {
      const file = readSession(key);
      if (file) return file;
    }
    return null;
  }

  /** Every stored session, this tab's included - a reset clears the lot. */
  static clear(): void {
    for (const { key } of storedSessions()) removeKey(key);
    removeKey(SESSION_KEY);
  }

  /**
   * Size + age of the stored session, or null when there is none. Read by the
   * Debug panel (debug-panel.md), which also offers to clear it: an autosave
   * the app chokes on is otherwise only escapable via a full factory reset.
   *
   * Deliberately **parse-free** (REQ-13): this is on a poll, and the payload is
   * the whole session — megabytes once samples are in play — so parsing it to
   * recover one number is out of all proportion to the answer.
   */
  static stats(): { bytes: number; savedAt: number | null } | null {
    // The one `load()` would pick, so the panel describes the session in play.
    const own = SESSION_PREFIX + tabId();
    let raw: string | null;
    try {
      raw = localStorage.getItem(own) ?? localStorage.getItem(storedSessions()[0]?.key ?? own);
    } catch {
      return null;
    }
    if (!raw) return null;
    // A payload we can't scan still reports its size — the half that helps.
    return { bytes: raw.length, savedAt: readSavedAt(raw) };
  }
}

/**
 * How far into the payload to look for `savedAt`. `write()` emits
 * `{"v":1,"savedAt":<13 digits>,"file":…}` — about 31 characters — and
 * `JSON.stringify` preserves that literal order, so a small window always
 * contains it. The bound is what makes the scan *correct* as well as cheap:
 * it cannot reach a `savedAt` occurring later inside `file`.
 */
const SAVED_AT_SCAN_CHARS = 96;
const SAVED_AT_RE = /"savedAt"\s*:\s*(\d+)/;

/**
 * One stored session, validated - or null. A corrupt or invalid payload removes
 * **that key only**, so one bad entry cannot take a healthy tab's session with it.
 */
function readSession(key: string): SongFile | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Partial<SessionPayload>;
    const res = validateSongFile(payload.file);
    if (res.ok) return res.file;
  } catch {
    // fall through to remove
  }
  removeKey(key);
  return null;
}

/** `savedAt` from the raw payload, or null if it isn't where write() puts it. */
function readSavedAt(raw: string): number | null {
  const m = SAVED_AT_RE.exec(raw.slice(0, SAVED_AT_SCAN_CHARS));
  if (!m) return null;
  const at = Number(m[1]);
  return Number.isFinite(at) ? at : null;
}

/** Structural view of the four chain lanes — playback ticks don't change it. */
function arrangementFingerprint(arr: Arrangement): string {
  return [arr.seq, arr.drum, arr.sampler, arr.motion]
    .map((l) => `${l.enabled ? 1 : 0}:${l.steps.join(',')}`)
    .join('|');
}
