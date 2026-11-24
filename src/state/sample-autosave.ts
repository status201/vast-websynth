import { SAMPLER_SLOT_COUNT } from './patterns';
import { IdbClipKv, LEGACY_CLIP_SESSION } from './idb-clip-kv';
import { encodeClipWav } from '../audio/recorder/encode';
import { audioBufferView } from '../audio/recorder/audio-buffer';

/**
 * Sampler-clip persistence — the audio half of the reload safety net
 * (`specs/features/sample-persistence.md`; the song half is `SessionAutosave`,
 * which this module deliberately mirrors: same debounce/flush/static-load
 * shape). Binary clips don't fit localStorage, so they live in IndexedDB as
 * 16-bit WAV bytes (the pure `encodeClipWav` — one channel when the clip's
 * two are identical, sample-persistence.md REQ-clips-persist-in-indexeddb),
 * keyed by session and slot (REQ-clips-belong-to-a-session): a tab's audio
 * belongs to its session, as its song does, so two tabs never share a slot.
 *
 * The storage backend is injected as a `ClipKv` so the reconcile logic is
 * unit-testable under jsdom, which has no IndexedDB. Every operation is a
 * silent no-op on failure (REQ-every-clip-storage-failure-is-survivable) — the app never breaks because a clip could
 * not be persisted.
 */

export { LEGACY_CLIP_SESSION };

/** One slot's persisted audio: WAV file bytes, under the session it belongs to.
 *  Names are NOT stored (REQ-clip-names-are-not-stored). */
export interface StoredClip {
  /** A `SessionAutosave` key, or `LEGACY_CLIP_SESSION`. */
  session: string;
  slot: number;
  data: Uint8Array;
}

/** What a boot read: the clips, and whose they were (`from`) — the restored
 *  session's own, or `LEGACY_CLIP_SESSION` when it adopted the v2 store's. */
export interface ClipRestore {
  from: string;
  clips: StoredClip[];
}

/** The storage surface this module needs. `IdbClipKv` is the production impl. */
export interface ClipKv {
  readSession(session: string): Promise<StoredClip[]>;
  /** The distinct sessions that hold clips — keys only, never the audio. */
  sessions(): Promise<string[]>;
  write(rec: StoredClip): Promise<void>;
  delete(session: string, slot: number): Promise<void>;
  deleteSession(session: string): Promise<void>;
  clear(): Promise<void>;
}

/** The narrow view of `SamplerMachine` this store reads (ADR-009 in spirit). */
export interface ClipSource {
  readonly buffers: readonly (AudioBuffer | null)[];
  onBufferChange(fn: (slot: number) => void): () => void;
}

export interface SampleAutosaveOptions {
  /** Default 800. */
  debounceMs?: number;
  /** This tab's session key — the only session this instance writes. */
  session: string;
  /** Is that session stored yet (REQ-a-session-is-written-before-its-clips)? Read once, at `attach`. */
  sessionExists: () => boolean;
}

const DEFAULT_DEBOUNCE_MS = 800;

/** One shared connection for the whole app — opened lazily on first use. */
let defaultKv: ClipKv | undefined;
function sharedKv(): ClipKv {
  defaultKv ??= new IdbClipKv();
  return defaultKv;
}

export class SampleAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly kv: ClipKv;
  private readonly debounceMs: number;
  private readonly session: string;
  private readonly sessionExists: () => boolean;
  /** What is currently in storage per slot, by AudioBuffer *reference* — the
   *  identity check that keeps an unchanged clip from being re-encoded (REQ-a-write-pass-reconciles-every-slot). */
  private readonly written: (AudioBuffer | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);
  private readonly bytes: number[] = Array(SAMPLER_SLOT_COUNT).fill(0);
  /** Serializes reconcile passes so a burst of edits never interleaves two. */
  private pass: Promise<void> = Promise.resolve();
  /** This tab's session is stored, so its clips may be (REQ-a-session-is-written-before-its-clips). */
  private ready = false;
  /** A pass came due before `ready`; it runs when the session is written. */
  private pending = false;
  /** Restored clips that are not this session's yet: the first pass writes them. */
  private unseeded = false;
  /** The boot adopted the v2 store's clips; drop them once a pass has stored them here. */
  private adoptedLegacy = false;

  constructor(
    private readonly sampler: ClipSource,
    kv: ClipKv | undefined,
    opts: SampleAutosaveOptions,
  ) {
    this.kv = kv ?? sharedKv();
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.session = opts.session;
    this.sessionExists = opts.sessionExists;
  }

  /**
   * Wire the one mutation hook. Call once at boot, AFTER the restore has run
   * and `noteRestored` has seeded the identity table — otherwise the restore
   * itself would schedule a pointless re-encode of every clip.
   */
  attach(): void {
    this.sampler.onBufferChange(() => this.touch());
    // IndexedDB cannot be flushed synchronously, so there is no `pagehide`
    // handler (REQ-a-pending-clip-write-cannot-be-flushed): hidden-visibility is the one chance to land a pending
    // write. Losing that race degrades to the pre-feature `.needs-reload`.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
    this.ready = this.sessionExists();
    // Restored audio that is not this session's own (another tab's session, or
    // the adopted v2 store) becomes its own on the first pass — now, if the
    // session is already stored; otherwise when it is.
    if (this.ready && this.unseeded) void this.schedule();
  }

  /** Arm (or re-arm) the debounced reconcile. */
  touch(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.debounceMs);
  }

  /** Run a pending reconcile now; resolves when the in-flight pass settles. */
  flush(): Promise<void> {
    if (this.timer === undefined) return this.pass;
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.run();
  }

  /**
   * Seed the identity table from the boot restore: these buffers came *out* of
   * storage, so they are already written and must not be encoded again — when
   * they came out of THIS session. Anyone else's are left unseeded, so the first
   * pass stores them here (REQ-a-session-is-written-before-its-clips).
   */
  noteRestored(restore: ClipRestore, buffers: readonly (AudioBuffer | null)[]): void {
    this.adoptedLegacy = restore.from === LEGACY_CLIP_SESSION && restore.clips.length > 0;
    if (restore.from !== this.session) {
      this.unseeded = restore.clips.some((c) => buffers[c.slot] != null);
      return;
    }
    for (const c of restore.clips) {
      const buf = buffers[c.slot];
      if (!buf) continue;
      this.written[c.slot] = buf;
      this.bytes[c.slot] = c.data.length;
    }
  }

  /**
   * The session autosave wrote this tab's key (REQ-a-session-is-written-before-its-clips).
   * `fresh` — the key was absent before: a new tab, a tab running on another
   * tab's restored session, or a session pruned and written again. Whatever
   * this instance thinks it wrote is then not stored under a session that
   * exists, so every loaded slot is written afresh.
   */
  sessionWritten(fresh: boolean): void {
    if (fresh) {
      this.written.fill(null);
      this.bytes.fill(0);
    }
    const wasReady = this.ready;
    this.ready = true;
    if (fresh || (!wasReady && (this.pending || this.unseeded))) {
      this.pending = false;
      void this.schedule();
    }
  }

  /** What the Debug panel reports — this tab's clips, from in-memory bookkeeping, never an IDB read. */
  stats(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (let slot = 0; slot < SAMPLER_SLOT_COUNT; slot++) {
      if (!this.written[slot]) continue;
      count++;
      bytes += this.bytes[slot] ?? 0;
    }
    return { count, bytes };
  }

  /** A pass came due: run it, or hold it until the session exists. */
  private run(): Promise<void> {
    if (!this.ready) {
      this.pending = true;
      return this.pass;
    }
    return this.schedule();
  }

  private schedule(): Promise<void> {
    this.pass = this.pass.then(() => this.reconcile());
    return this.pass;
  }

  /** Bring this session's storage in line with the live slots — one pass over all of them. */
  private async reconcile(): Promise<void> {
    let complete = true;
    for (let slot = 0; slot < SAMPLER_SLOT_COUNT; slot++) {
      const buf = this.sampler.buffers[slot] ?? null;
      if (buf === this.written[slot]) continue; // unchanged (covers null/null)
      try {
        if (!buf) {
          await this.kv.delete(this.session, slot);
          this.written[slot] = null;
          this.bytes[slot] = 0;
          continue;
        }
        // Read uncopied: the encode is synchronous, so nothing can change the
        // buffer between the read and the write (audioBufferView).
        const { left, right, sampleRate } = audioBufferView(buf);
        const data = new Uint8Array(await encodeClipWav(left, right, sampleRate).arrayBuffer());
        await this.kv.write({ session: this.session, slot, data });
        this.written[slot] = buf;
        this.bytes[slot] = data.length;
      } catch {
        // Quota / private mode / no IndexedDB: stand down silently, and leave
        // `written` untouched so the next pass retries this slot.
        complete = false;
      }
    }
    this.unseeded = false;
    // The adopted v2 clips are this session's now (REQ-legacy-clips-are-adopted-once).
    // Only after a pass that stored everything: a failed write keeps the
    // originals, so the next boot can adopt them again.
    if (this.adoptedLegacy && complete) {
      this.adoptedLegacy = false;
      await SampleAutosave.dropSession(LEGACY_CLIP_SESSION, this.kv);
    }
  }

  /**
   * The clips a boot restores for `session` (REQ-clips-belong-to-a-session) —
   * or, when it has none of its own, the v2 store's (REQ-legacy-clips-are-adopted-once).
   * Never rejects (no clips on failure).
   */
  static async loadFor(session: string, kv: ClipKv = sharedKv()): Promise<ClipRestore> {
    try {
      const own = await kv.readSession(session);
      if (own.length > 0) return { from: session, clips: own };
      const legacy = await kv.readSession(LEGACY_CLIP_SESSION);
      return legacy.length > 0 ? { from: LEGACY_CLIP_SESSION, clips: legacy } : { from: session, clips: [] };
    } catch {
      return { from: session, clips: [] };
    }
  }

  /** Drop one session's clip for one slot (an orphan at restore time). Never rejects. */
  static async drop(session: string, slot: number, kv: ClipKv = sharedKv()): Promise<void> {
    try {
      await kv.delete(session, slot);
    } catch {
      // storage unavailable — nothing to drop
    }
  }

  /** Drop every clip of one session — it was removed (REQ-clips-go-with-their-session). Never rejects. */
  static async dropSession(session: string, kv: ClipKv = sharedKv()): Promise<void> {
    try {
      await kv.deleteSession(session);
    } catch {
      // storage unavailable — nothing to drop
    }
  }

  /**
   * Drop the clips of every session not in `keep()` (REQ-clips-go-with-their-session):
   * the boot's catch-all for a removal whose clip delete never ran. `keep` is
   * read AFTER the store is listed, so a session another tab stores meanwhile
   * (and then writes clips under) is counted as live. Never rejects.
   */
  static async sweep(keep: () => readonly string[], kv: ClipKv = sharedKv()): Promise<void> {
    try {
      const present = await kv.sessions();
      const keepSet = new Set(keep());
      for (const session of present) {
        if (!keepSet.has(session)) await kv.deleteSession(session);
      }
    } catch {
      // storage unavailable — nothing to sweep
    }
  }

  /** Wipe the store (factory reset, or a boot with no session). Never rejects. */
  static async clear(kv: ClipKv = sharedKv()): Promise<void> {
    try {
      await kv.clear();
    } catch {
      // storage unavailable — nothing to clear
    }
  }
}
